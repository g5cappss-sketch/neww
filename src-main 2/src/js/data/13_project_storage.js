    function readProjectBufferAsDataUrl(buffer) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('Không đọc được dữ liệu GLB.'));
        reader.readAsDataURL(new Blob([buffer], { type: 'model/gltf-binary' }));
      });
    }

    function socketReference(socket) {
      return socket ? { index: socket.index, dir: socket.dir || socket.type || 'vertical' } : null;
    }

    async function saveProjectFile() {
      try {
        const partSnapshots = parts.map(part => {
          const worldPosition = part.getWorldPosition(new THREE.Vector3());
          const worldRotation = new THREE.Euler().setFromQuaternion(part.getWorldQuaternion(new THREE.Quaternion()));
          return {
            id: part.userData.id,
            name: part.userData.name,
            kind: part.userData.kind || inferPartKind(part),
            libraryItemId: part.userData.libraryItemId || null,
            category: part.userData.category || null,
            color: part.userData.color,
            holesCount: (part.userData.holes || []).length,
            holes: part.userData.holes,
            pos: [worldPosition.x, worldPosition.y, worldPosition.z],
            rot: [worldRotation.x, worldRotation.y, worldRotation.z],
            worldSpace: true
          };
        });

        const libraryIds = [...new Set(partSnapshots.map(part => part.libraryItemId).filter(Boolean))];
        const storedModels = await getSavedSystemModels();
        const libraryModels = [];
        for (const id of libraryIds) {
          const item = customInventory.find(candidate => candidate.id === id);
          const storedItem = storedModels.find(candidate => candidate.id === id);
          let glbData = item?.sourceGLBData || storedItem?.glbData || null;
          if (!glbData && item?.sourceGLBBuffer) glbData = await readProjectBufferAsDataUrl(item.sourceGLBBuffer);
          if (!glbData && storedItem?.glbBuffer) glbData = await readProjectBufferAsDataUrl(storedItem.glbBuffer);
          if (glbData) {
            libraryModels.push({
              id,
              name: item?.name || storedItem?.name || id,
              category: item?.category || storedItem?.category || 'custom',
              holesCount: item?.holesCount || storedItem?.holesCount || 0,
              thumbnail: item?.thumbnail || storedItem?.thumbnail || null,
              glbData
            });
          }
        }

        const projectData = {
          version: '1.1',
          date: new Date().toISOString(),
          parts: partSnapshots,
          joints: joints.map(joint => ({
            id: joint.id,
            partA: joint.partA?.userData?.id,
            partB: joint.partB?.userData?.id,
            pin: joint.pin?.userData?.id || null,
            socketA: socketReference(joint.socketA),
            socketB: socketReference(joint.socketB),
            kinematicParent: joint.kinematicParent?.userData?.id || null,
            kinematicChild: joint.kinematicChild?.userData?.id || null
          })),
          libraryModels
        };

        const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `du_an_co_khi_${Date.now()}.craft3d.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        showToast('Đã lưu dự án lắp ghép');
      } catch (error) {
        console.error(error);
        showToast('Không thể tạo file dự án.', 'error');
      }
    }

    function decodeProjectLibraryBuffer(dataUrl) {
      const encoded = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return bytes.buffer;
    }

    async function restoreProjectLibraryModels(models = []) {
      for (const model of models) {
        if (!model.glbData || customInventory.some(item => item.id === model.id)) continue;
        const buffer = decodeProjectLibraryBuffer(model.glbData);
        await new Promise((resolve, reject) => {
          parseGLBBuffer(buffer, `${model.name || model.id}.glb`, {
            isRestoring: true,
            originalId: model.id,
            name: model.name,
            category: model.category || 'custom',
            sourceGLBData: model.glbData,
            sourceGLBBuffer: buffer,
            thumbnail: model.thumbnail,
            onRestored: resolve,
            onRestoreError: reject
          });
        });
      }
    }

    function restoreProjectJoints(savedJoints, partsById) {
      joints = (Array.isArray(savedJoints) ? savedJoints : []).flatMap(saved => {
        const partA = partsById.get(saved.partA);
        const partB = partsById.get(saved.partB);
        if (!partA || !partB) return [];
        const pin = saved.pin ? partsById.get(saved.pin) : null;
        const resolveSocket = (part, reference) => (part.userData.holes || []).find(socket =>
          socket.index === reference?.index && (socket.dir || socket.type || 'vertical') === (reference?.dir || 'vertical')) || null;
        const socketA = resolveSocket(partA, saved.socketA);
        const socketB = resolveSocket(partB, saved.socketB);
        if (!socketA || !socketB) return [];
        return [{
          id: saved.id || `magnetic_joint_${Date.now()}_${joints.length}`,
          partA,
          partB,
          pin,
          socketA,
          socketB,
          kinematicParent: saved.kinematicParent ? partsById.get(saved.kinematicParent) : undefined,
          kinematicChild: saved.kinematicChild ? partsById.get(saved.kinematicChild) : undefined
        }];
      });
      if (typeof syncMagneticStateForParts === 'function') syncMagneticStateForParts(new Set(parts));
    }

    function loadProjectFile(file) {
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async event => {
        try {
          const data = JSON.parse(event.target.result);
          if (!data || !Array.isArray(data.parts)) throw new Error('Thiếu danh sách linh kiện.');
          await restoreProjectLibraryModels(data.libraryModels);

          if (typeof restoreRotationPivot === 'function') restoreRotationPivot();
          const assemblyGroups = new Set(parts
            .map(part => part.parent)
            .filter(parent => parent?.userData?.isAssemblyGroup));
          parts.forEach(part => part.removeFromParent());
          assemblyGroups.forEach(group => group.parent?.remove(group));
          clearAllParts({ skipHistory: true });
          const partsById = new Map();
          data.parts.forEach(entry => {
            let part = rebuildProjectPartFromSnapshot(entry);
            if (!part) {
              const estimatedCount = entry.holesCount || entry.holes?.length || 7;
              part = spawnTechnicBeam(estimatedCount, entry.color || 0x94a3b8, entry.name || 'Dầm Kỹ Thuật', { skipHistory: true, skipSelect: true });
            }
            if (!part) return;
            if (entry.id) part.userData.id = entry.id;
            part.userData.name = entry.name || part.userData.name;
            part.position.set(entry.pos?.[0] ?? 0, entry.pos?.[1] ?? 0, entry.pos?.[2] ?? 0);
            part.rotation.set(entry.rot?.[0] ?? 0, entry.rot?.[1] ?? 0, entry.rot?.[2] ?? 0);
            if (entry.color != null) {
              part.userData.color = entry.color;
              part.traverse(child => {
                if (child.isMesh && child.material?.color && !child.userData.isBadge) {
                  child.material.color.set(entry.color);
                }
              });
            }
            part.updateMatrixWorld(true);
            partsById.set(part.userData.id, part);
          });

          restoreProjectJoints(data.joints, partsById);
          if (joints.length && typeof reconcileRigidAssemblies === 'function') reconcileRigidAssemblies();
          selectPart(null);
          updatePartsCount();
          updateJointsUI();
          recordHistoryState();
          if (parts.length) fitCameraToParts(parts);
          showToast('Đã mở dự án thành công');
        } catch (error) {
          console.error(error);
          showToast('File dự án không hợp lệ hoặc thiếu model thư viện.', 'error');
        }
      };
      reader.readAsText(file);
    }

