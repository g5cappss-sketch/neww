// 1. Ghi lại trạng thái lịch sử
    function recordHistoryState() {
      const hasKinematicHierarchy = Boolean(rotationPivotGroup);
      const state = parts.map(p => {
        const assemblyGroup = p.parent?.userData.isAssemblyGroup ? p.parent : null;
        const worldPosition = hasKinematicHierarchy ? p.getWorldPosition(new THREE.Vector3()) : null;
        const worldRotation = hasKinematicHierarchy
          ? new THREE.Euler().setFromQuaternion(p.getWorldQuaternion(new THREE.Quaternion()))
          : null;
        return {
          id: p.userData.id,
          kind: inferPartKind(p),
          name: p.userData.name,
          pos: worldPosition || p.position.clone(),
          rot: worldRotation || p.rotation.clone(),
          worldSpace: hasKinematicHierarchy,
          assemblyPos: hasKinematicHierarchy ? null : assemblyGroup?.position.clone() || null,
          assemblyRot: hasKinematicHierarchy ? null : assemblyGroup?.rotation.clone() || null,
          color: p.userData.color,
          holesCount: (p.userData.holes || []).length,
          libraryItemId: p.userData.libraryItemId || null,
          category: p.userData.category || null
        };
      });

      history = history.slice(0, historyIndex + 1);
      history.push(state);
      historyIndex++;
      updateHistoryButtons();
    }

    // 2. Quay lại trạng thái trước (Undo)
    function undoAssembly() {
      if (historyIndex > 0) {
        historyIndex--;
        restoreHistoryState(history[historyIndex]);
        updateHistoryButtons();
      } else if (historyIndex === 0) {
        // Khi đang ở bước 1 mà bấm Trước -> Quay về trạng thái trống (index = -1)
        historyIndex--;
        clearAllParts({ skipHistory: true }); // Xóa sạch model trên màn hình
        updateHistoryButtons();
        showToast('Đã về trạng thái ban đầu (Trống)');
      }
    }

    // 3. Tiến tới trạng thái sau (Redo)
    function redoAssembly() {
      if (historyIndex < history.length - 1) {
        historyIndex++;
        restoreHistoryState(history[historyIndex]);
        updateHistoryButtons();
      }
    }

    // 4. Khôi phục trạng thái từ lịch sử
    function restoreHistoryState(state) {
      restoreRotationPivot();
      const snapshot = Array.isArray(state) ? state : [];
      const restoreWorldSpace = snapshot.some(saved => saved.worldSpace);
      if (restoreWorldSpace) {
        const oldGroups = new Set(parts
          .map(part => part.parent)
          .filter(parent => parent?.userData.isAssemblyGroup && !parent.userData.isRotationPivotGroup));
        oldGroups.forEach(group => {
          [...group.children].forEach(child => scene.attach(child));
          group.parent?.remove(group);
        });
      }
      const snapshotIds = new Set(snapshot.map(s => s.id));

      const partsToRemove = parts.filter(part => !snapshotIds.has(part.userData.id));
      partsToRemove.forEach(part => {
        scene.remove(part);
      });
      parts = parts.filter(part => snapshotIds.has(part.userData.id));

      snapshot.forEach(saved => {
        let part = parts.find(p => p.userData.id === saved.id);
        if (!part) {
          const restored = rebuildProjectPartFromSnapshot(saved);
          if (restored) {
            part = restored;
          }
        }

        if (!part) return;

        if (saved.worldSpace) scene.attach(part);
        part.position.copy(saved.pos);
        part.rotation.copy(saved.rot);
        if (!saved.worldSpace && saved.assemblyPos && part.parent?.userData.isAssemblyGroup) {
          part.parent.position.copy(saved.assemblyPos);
          part.parent.rotation.copy(saved.assemblyRot);
        }
        if (saved.color != null && part.userData) part.userData.color = saved.color;
        if (saved.name && part.userData) part.userData.name = saved.name;
        if (saved.holesCount && part.userData) part.userData.holesCount = saved.holesCount;
      });

      if (restoreWorldSpace) reconcileRigidAssemblies();
      updatePartsCount();
      updateJointsUI();
      if (selectedPart && toolMode !== 'select') {
        attachTransformControlsForPart(selectedPart, toolMode);
      }
    }

    // 5. Hàm cập nhật nút sáng/mờ (DUY NHẤT HÀM NÀY)
    function updateHistoryButtons() {
      const undoBtn = document.getElementById('history-undo');
      const redoBtn = document.getElementById('history-redo');
      
      if (undoBtn) undoBtn.disabled = (historyIndex < 0);
      if (redoBtn) redoBtn.disabled = (historyIndex >= history.length - 1);
    }

    // ---------------------------------------------------------
    // CÁC HÀM TIỆN ÍCH (Giữ nguyên, không thay đổi)
    // ---------------------------------------------------------

    function setPartColor(hexColor) {
      if (!selectedPart) return;
      selectedPart.traverse(child => {
        if (child.isMesh && child.material && !child.userData.isBadge) {
          child.material.color.set(hexColor);
        }
      });
      selectedPart.userData.color = hexColor;
      recordHistoryState();
      showToast('Đã cập nhật màu sắc');
    }

    function toggleWireframe(checked) {
      const targetList = selectedPart ? [selectedPart] : parts;
      targetList.forEach(p => p.traverse(c => {
        if (c.isMesh && c.material) c.material.wireframe = checked;
      }));
    }

    function toggleAxes(checked) {
      if (axesHelper) axesHelper.visible = checked;
    }

    function toggleAngleSnap(checked) {
      angleSnapEnabled = checked;
      transformControls.rotationSnap = checked ? Math.PI / 4 : null;
      showToast(checked ? 'Bật bắt dính góc 45°' : 'Tắt bắt dính góc');
    }

    function rebuildProjectPartFromSnapshot(data) {
      if (!data || !data.kind) return null;

      if (data.libraryItemId) {
        const libraryItem = customInventory.find(item => item.id === data.libraryItemId);
        if (libraryItem?.modelScene) {
          const part = libraryItem.modelScene.clone();
          const category = data.category || libraryItem.category;
          part.userData = {
            ...part.userData,
            id: data.id,
            name: data.name || libraryItem.name,
            kind: category === 'pins' ? 'pin' : category === 'beams' ? 'beam' : category === 'motors' ? 'motor' : 'custom',
            category,
            libraryItemId: libraryItem.id,
            isPin: category === 'pins'
          };
          scene.add(part);
          parts.push(part);
          return part;
        }
      }

      if (data.kind === 'beam') {
        const part = spawnTechnicBeam(data.holesCount || 7, data.color || 0x94a3b8, data.name || 'Dầm Kỹ Thuật', { skipHistory: true, skipSelect: true });
        if (part) {
          if (data.id) part.userData.id = data.id;
          part.userData.kind = 'beam';
          part.position.set(data.pos?.[0] ?? 0, data.pos?.[1] ?? 0, data.pos?.[2] ?? 0);
          part.rotation.set(data.rot?.[0] ?? 0, data.rot?.[1] ?? 0, data.rot?.[2] ?? 0);
          return part;
        }
      }

      if (data.kind === 'dv-bar') {
        const part = spawnDVBar(data.holesCount || 5, { skipHistory: true, skipSelect: true });
        if (part) {
          if (data.id) part.userData.id = data.id;
          part.userData.kind = 'dv-bar';
          part.position.set(data.pos?.[0] ?? 0, data.pos?.[1] ?? 0, data.pos?.[2] ?? 0);
          part.rotation.set(data.rot?.[0] ?? 0, data.rot?.[1] ?? 0, data.rot?.[2] ?? 0);
          return part;
        }
      }

      if (data.kind === 'yellow-bracket') {
        const part = spawnYellowBracket({ skipHistory: true, skipSelect: true });
        if (part) {
          if (data.id) part.userData.id = data.id;
          part.userData.kind = 'yellow-bracket';
          part.position.set(data.pos?.[0] ?? 0, data.pos?.[1] ?? 0, data.pos?.[2] ?? 0);
          part.rotation.set(data.rot?.[0] ?? 0, data.rot?.[1] ?? 0, data.rot?.[2] ?? 0);
          return part;
        }
      }

      if (data.kind === 'pin') {
        const part = spawnStandalonePin(data.color || 0x0284c7, { skipHistory: true, skipSelect: true });
        if (part) {
          if (data.id) part.userData.id = data.id;
          part.userData.kind = 'pin';
          part.position.set(data.pos?.[0] ?? 0, data.pos?.[1] ?? 0, data.pos?.[2] ?? 0);
          part.rotation.set(data.rot?.[0] ?? 0, data.rot?.[1] ?? 0, data.rot?.[2] ?? 0);
          return part;
        }
      }

      return null;
    }