const STORAGE_KEY = 'zmrobo_system_models_v1';
  const MODEL_DATABASE_NAME = 'zmrobo_model_library';
  const MODEL_DATABASE_VERSION = 1;
  const MODEL_OBJECT_STORE = 'models';

    function getLibraryPartKind(category) {
      return { beams: 'beam', pins: 'pin', motors: 'motor', custom: 'custom' }[category] || 'custom';
    }

    // ============================================================== 
    // 1. HỆ THỐNG LƯU TRỮ MODEL BẰNG INDEXEDDB
    // ============================================================== 
    function openModelDatabase() {
      return new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) {
          reject(new Error('Trình duyệt không hỗ trợ IndexedDB.'));
          return;
        }
        const request = indexedDB.open(MODEL_DATABASE_NAME, MODEL_DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(MODEL_OBJECT_STORE)) {
            database.createObjectStore(MODEL_OBJECT_STORE, { keyPath: 'id' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Không mở được kho model.'));
      });
    }

    async function getSavedSystemModels() {
      const database = await openModelDatabase();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(MODEL_OBJECT_STORE, 'readonly');
        const request = transaction.objectStore(MODEL_OBJECT_STORE).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error('Không đọc được kho model.'));
        transaction.oncomplete = () => database.close();
        transaction.onerror = () => database.close();
      });
    }

    async function putSavedSystemModel(model) {
      const database = await openModelDatabase();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(MODEL_OBJECT_STORE, 'readwrite');
        transaction.objectStore(MODEL_OBJECT_STORE).put(model);
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error || new Error('Không ghi được model vào IndexedDB.'));
        };
        transaction.onabort = () => {
          database.close();
          reject(transaction.error || new Error('Lưu model đã bị hủy.'));
        };
      });
    }

    function decodeStoredModelData(dataUrl) {
      const encoded = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return bytes.buffer;
    }

    async function saveModelToSystem(partId, cleanName, holesCount, thumbnailData, glbBuffer, category) {
      const buffer = glbBuffer instanceof ArrayBuffer
        ? glbBuffer.slice(0)
        : glbBuffer.buffer.slice(glbBuffer.byteOffset, glbBuffer.byteOffset + glbBuffer.byteLength);
      let persistenceRequest;
      try {
        persistenceRequest = navigator.storage?.persist?.();
      } catch (error) {
        console.warn('Không thể yêu cầu persistent storage:', error);
      }
      await putSavedSystemModel({
        id: partId,
        name: cleanName,
        category,
        holesCount,
        thumbnail: thumbnailData,
        glbBuffer: buffer,
        timestamp: Date.now()
      });
      try {
        await persistenceRequest;
      } catch (error) {
        console.warn('Không thể yêu cầu persistent storage:', error);
      }
    }

    async function migrateLegacySystemModels() {
      const savedData = localStorage.getItem(STORAGE_KEY);
      if (!savedData) return;
      const legacyModels = JSON.parse(savedData);
      if (!Array.isArray(legacyModels) || legacyModels.length === 0) return;

      const currentModels = await getSavedSystemModels();
      const savedIds = new Set(currentModels.map(model => model.id));
      let migrationSucceeded = true;
      for (const model of legacyModels) {
        if (!model.id || !model.glbData || savedIds.has(model.id)) continue;
        try {
          await putSavedSystemModel({
            ...model,
            glbBuffer: decodeStoredModelData(model.glbData)
          });
        } catch (error) {
          migrationSucceeded = false;
          console.error('Không thể di trú model cũ:', model.name, error);
        }
      }
      if (migrationSucceeded) localStorage.removeItem(STORAGE_KEY);
    }

    async function loadSystemModelsOnStartup() {
      try {
        await migrateLegacySystemModels();
        const savedModels = await getSavedSystemModels();
        for (const savedItem of savedModels) {
          if (customInventory.some(item => item.id === savedItem.id)) continue;
          const buffer = savedItem.glbBuffer || decodeStoredModelData(savedItem.glbData);
          parseGLBBuffer(buffer, `${savedItem.name}.glb`, {
            isRestoring: true,
            originalId: savedItem.id,
            name: savedItem.name,
            category: savedItem.category || 'custom',
            sourceGLBBuffer: buffer,
            sourceGLBData: savedItem.glbData || null
          });
        }
      } catch (error) {
        console.error('Lỗi khi tải lại kho model hệ thống:', error);
        if (typeof showToast === 'function') {
          showToast('Không thể mở kho model đã lưu. Dữ liệu cũ vẫn được giữ nguyên.', 'error');
        }
      }
    }

    // Tự động khôi phục dữ liệu ngay khi load trang
    window.addEventListener('DOMContentLoaded', () => {
      loadSystemModelsOnStartup();
    });

    // ==============================================================
    // 2. CÁC HÀM XỬ LÝ GIAO DIỆN & KÉO THẢ NHẬP FILE
    // ==============================================================
    function setupDragDrop() {
      const container = document.getElementById('canvas-container');
      const canvas = document.getElementById('webgl-canvas');
      const overlay = document.getElementById('glb-drop-overlay');
      const sidebar = document.getElementById('sidebar');

      sidebar.addEventListener('dragstart', event => {
        const card = event.target.closest('[data-library-item][data-model-id]');
        if (!card || !event.dataTransfer) return;
        event.dataTransfer.setData('modelId', card.dataset.modelId);
        event.dataTransfer.effectAllowed = 'copy';
      });

      const isModelDrag = event => Array.from(event.dataTransfer?.types || [])
        .some(type => type.toLowerCase() === 'modelid');

      canvas.addEventListener('dragover', event => {
        if (!isModelDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      });
      canvas.addEventListener('drop', event => {
        const modelId = event.dataTransfer?.getData('modelId');
        if (!modelId) return;
        event.preventDefault();
        event.stopPropagation();
        overlay.classList.add('hidden');

        const rect = canvas.getBoundingClientRect();
        const mouse = new THREE.Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          -((event.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, camera);
        const groundPoint = raycaster.ray.intersectPlane(
          new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
          new THREE.Vector3()
        );
        if (groundPoint) spawnLibraryModelAt(modelId, groundPoint);
      });

      container.addEventListener('dragover', event => {
        event.preventDefault();
        if (isModelDrag(event)) {
          overlay.classList.add('hidden');
          return;
        }
        overlay.classList.remove('hidden');
      });
      container.addEventListener('dragleave', (e) => { e.preventDefault(); if (!container.contains(e.relatedTarget)) overlay.classList.add('hidden'); });
      container.addEventListener('drop', (e) => {
        e.preventDefault();
        overlay.classList.add('hidden');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          handleGLBFileInput(e.dataTransfer.files[0]);
        }
      });
    }

    function spawnLibraryModelAt(modelId, groundPoint) {
      if (modelId.startsWith('custom:')) {
        spawnFromCustomInventory(modelId.slice('custom:'.length), groundPoint);
        return;
      }

      const card = [...document.querySelectorAll('[data-library-item][data-model-id]')]
        .find(item => item.dataset.modelId === modelId);
      if (!card) return;

      const options = { skipHistory: true, skipSelect: true, spawnPoint: groundPoint };
      const holesCount = Number(card.dataset.holesCount);
      const color = Number(card.dataset.color);
      let part = null;

      if (card.dataset.spawnKind === 'beam') {
        part = spawnTechnicBeam(holesCount, color, 'Dầm Kỹ Thuật', options);
      } else if (card.dataset.spawnKind === 'dv-bar') {
        part = spawnDVBar(holesCount, options);
      } else if (card.dataset.spawnKind === 'yellow-bracket') {
        part = spawnYellowBracket(options);
      } else if (card.dataset.spawnKind === 'pin') {
        part = spawnStandalonePin(color, options);
      }

      if (!part) return;
      selectPart(part);
      updatePartsCount();
      recordHistoryState();
      showToast(`Đã thêm ${part.userData.name}`);
    }

    function setupFileInputs() {
      const modelInput = document.getElementById('model-file-input');
      const projectInput = document.getElementById('project-file-input');

      if (modelInput) {
        modelInput.addEventListener('change', (e) => {
          if (e.target.files && e.target.files[0]) handleGLBFileInput(e.target.files[0]);
          e.target.value = '';
        });
      }
      if (projectInput) {
        projectInput.addEventListener('change', (e) => {
          if (e.target.files && e.target.files[0]) loadProjectFile(e.target.files[0]);
          e.target.value = '';
        });
      }

      const importModal = document.getElementById('glb-import-modal');
      importModal?.addEventListener('click', event => {
        if (event.target === importModal) cancelGLBImport();
      });
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && pendingGLBImport) cancelGLBImport();
      });

      setupLibraryFiltering();
    }

    function setupLibraryFiltering() {
      const searchInput = document.getElementById('library-search');
      searchInput?.addEventListener('input', filterLibraryItems);
      document.querySelectorAll('[data-library-filter]').forEach(button => {
        button.addEventListener('click', () => {
          activeLibraryFilter = button.dataset.libraryFilter || 'all';
          document.querySelectorAll('[data-library-filter]').forEach(tab => {
            const active = tab === button;
            tab.classList.toggle('is-active', active);
            tab.setAttribute('aria-pressed', String(active));
          });
          filterLibraryItems();
        });
      });
      document.addEventListener('keydown', event => {
        if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
        event.preventDefault();
        searchInput?.focus();
      });
      filterLibraryItems();
    }

    function filterLibraryItems() {
      const query = (document.getElementById('library-search')?.value || '').trim().toLocaleLowerCase();
      document.querySelectorAll('[data-library-item]').forEach(card => {
        const category = card.dataset.libraryCategory || 'custom';
        const categoryMatches = activeLibraryFilter === 'all' ||
          activeLibraryFilter === category ||
          (activeLibraryFilter === 'devices' && ['motors', 'custom'].includes(category));
        const nameMatches = !query || (card.dataset.libraryName || '').toLocaleLowerCase().includes(query);
        card.hidden = !categoryMatches || !nameMatches;
      });

      document.querySelectorAll('[data-library-folder]').forEach(folder => {
        const category = folder.dataset.libraryFolder;
        const categoryMatches = activeLibraryFilter === 'all' || activeLibraryFilter === category ||
          (activeLibraryFilter === 'devices' && ['motors', 'custom'].includes(category));
        const hasMatches = [...folder.querySelectorAll('[data-library-item]')].some(card => !card.hidden);
        folder.hidden = !categoryMatches || (query.length > 0 && !hasMatches);
        if (!folder.hidden && (query || activeLibraryFilter !== 'all')) folder.open = true;
      });
    }

    function createFallbackLibraryThumbnail() {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 160;
      const context = canvas.getContext('2d');
      const gradient = context.createLinearGradient(20, 20, 140, 140);
      gradient.addColorStop(0, '#164e63');
      gradient.addColorStop(1, '#0f172a');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 160, 160);
      context.strokeStyle = 'rgba(103,232,249,0.9)';
      context.lineWidth = 5;
      context.lineJoin = 'round';
      context.beginPath();
      context.moveTo(48, 58);
      context.lineTo(82, 38);
      context.lineTo(116, 58);
      context.lineTo(116, 101);
      context.lineTo(82, 121);
      context.lineTo(48, 101);
      context.closePath();
      context.moveTo(82, 38);
      context.lineTo(82, 80);
      context.lineTo(116, 58);
      context.moveTo(82, 80);
      context.lineTo(48, 58);
      context.moveTo(82, 80);
      context.lineTo(82, 121);
      context.stroke();
      return canvas.toDataURL('image/png');
    }

    function setupMobileSidebar() {
      const toggleBtn = document.getElementById('mobile-toggle-btn');
      const sidebar = document.getElementById('sidebar');
      if (!toggleBtn || !sidebar) return;

      toggleBtn.addEventListener('click', () => {
        sidebar.classList.toggle('hidden');
        sidebar.classList.toggle('md:flex', !sidebar.classList.contains('hidden'));
      });
    }

    function handleGLBFileInput(file) {
      if (!file) return;
      if (!/\.(glb|gltf)$/i.test(file.name)) {
        showToast('Chỉ hỗ trợ file .GLB hoặc .GLTF.', 'error');
        return;
      }
      const reader = new FileReader();
      reader.onload = (evt) => {
        parseGLBBuffer(evt.target.result, file.name, { pendingImport: true });
      };
      reader.onerror = () => showToast('Không thể đọc file GLB.', 'error');
      reader.readAsArrayBuffer(file);
    }

    function cancelGLBImport() {
      pendingGLBImport = null;
      document.getElementById('glb-import-modal')?.classList.add('hidden');
    }

    function confirmGLBImport(event) {
      event?.preventDefault();
      if (!pendingGLBImport) return;

      const name = document.getElementById('glb-import-name').value.trim();
      const category = document.getElementById('glb-import-category').value;
      if (!name || !libraryItemsByCategory[category]) return;

      const { root, fileName, buffer, thumbnail, holes } = pendingGLBImport;
      const itemId = 'glb_library_' + Date.now();
      root.userData = {
        id: itemId,
        name,
        holes,
        holesCount: holes.length,
        kind: getLibraryPartKind(category),
        category,
        isPin: category === 'pins',
        isCustomPart: true
      };
      registerCustomInventoryItem({
        id: itemId,
        name,
        category,
        holesCount: holes.length,
        modelScene: root,
        thumbnail,
        sourceGLBBuffer: buffer.slice(0)
      });
      saveModelToSystem(itemId, name, holes.length, thumbnail, buffer, category)
        .then(() => showToast(`Đã lưu vĩnh viễn "${name}" vào thư viện`))
        .catch(error => {
          console.error('Không thể lưu model vào IndexedDB:', error);
          showToast('Model đã nhập nhưng không lưu được lâu dài. Hãy kiểm tra dung lượng lưu trữ trình duyệt.', 'error');
        });
      pendingGLBImport = null;
      document.getElementById('glb-import-modal')?.classList.add('hidden');
      showToast(`Đã thêm "${name}" vào thư viện`);
    }

    // ==============================================================
    // 3. TẠO THUMBNAIL (ẢNH THU NHỎ) TỪ MODEL 3D
    // ==============================================================
    function generateGLBThumbnail(object3D) {
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 120;
      
      const thumbRenderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
      thumbRenderer.setSize(120, 120);

      const thumbScene = new THREE.Scene();
      const thumbCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);

      const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
      thumbScene.add(ambientLight);
      const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
      dirLight.position.set(5, 10, 7);
      thumbScene.add(dirLight);

      const modelClone = object3D.clone();
      const badgeGroup = modelClone.getObjectByName('badges');
      if (badgeGroup) badgeGroup.parent?.remove(badgeGroup);
      thumbScene.add(modelClone);

      thumbScene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(modelClone);
      const center = new THREE.Vector3();
      box.getCenter(center);
      const size = new THREE.Vector3();
      box.getSize(size);
      const radius = Math.max(size.length() * 0.5, 0.01);
      const fillRatio = 0.86;
      const cameraAway = new THREE.Vector3(1, 0.75, 1).normalize();
      thumbCamera.position.copy(center).add(cameraAway);
      thumbCamera.lookAt(center);
      thumbCamera.updateMatrixWorld(true);

      const cameraRight = new THREE.Vector3().setFromMatrixColumn(thumbCamera.matrixWorld, 0);
      const cameraUp = new THREE.Vector3().setFromMatrixColumn(thumbCamera.matrixWorld, 1);
      const cameraDepth = new THREE.Vector3().setFromMatrixColumn(thumbCamera.matrixWorld, 2);
      const tanHalfVertical = Math.tan(THREE.MathUtils.degToRad(thumbCamera.fov * 0.5));
      const tanHalfHorizontal = tanHalfVertical * thumbCamera.aspect;
      let fitDistance = 0;

      for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            const offset = new THREE.Vector3(x, y, z).sub(center);
            const depth = offset.dot(cameraDepth);
            const horizontalDistance = Math.abs(offset.dot(cameraRight)) / (tanHalfHorizontal * fillRatio);
            const verticalDistance = Math.abs(offset.dot(cameraUp)) / (tanHalfVertical * fillRatio);
            fitDistance = Math.max(fitDistance, depth + horizontalDistance, depth + verticalDistance);
          }
        }
      }

      fitDistance = Math.max(fitDistance * 1.025, radius * 1.05);
      thumbCamera.position.copy(center).addScaledVector(cameraAway, fitDistance);
      thumbCamera.near = Math.max(fitDistance - radius * 2.5, 0.001);
      thumbCamera.far = fitDistance + radius * 2.5;
      thumbCamera.lookAt(center);
      thumbCamera.updateProjectionMatrix();

      thumbRenderer.render(thumbScene, thumbCamera);
      const dataURL = canvas.toDataURL('image/png');
      thumbRenderer.dispose();
      return dataURL;
    }

    // ==============================================================
    // 4. BỘ XỬ LÝ MODEL (GLB PARSER) & KẾT NỐI DANH SÁCH MENU UI
    // ==============================================================
    function getModelLongitudinalAxis(model) {
      model.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(model);
      if (bounds.isEmpty()) return [0, 1, 0];

      const size = bounds.getSize(new THREE.Vector3());
      const axisIndex = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
      const worldAxis = new THREE.Vector3().setComponent(axisIndex, 1);
      return worldAxis.applyQuaternion(model.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize().toArray();
    }

    function parseGLBBuffer(buffer, fileName, options = {}) {
      const loader = new THREE.GLTFLoader();
      loader.parse(buffer, '', (gltf) => {
        const root = gltf.scene || gltf.scenes[0];
        root.updateMatrixWorld(true);
        const inverseRootMatrix = root.matrixWorld.clone().invert();
        const inverseRootQuaternion = root.getWorldQuaternion(new THREE.Quaternion()).invert();
        const detectedHoles = [];
        const garbage = [];

        root.traverse(child => {
          if (child.isCamera || child.isLight) garbage.push(child);
          if (child.isMesh && child.geometry) {
            child.geometry.computeBoundingBox();
            const sz = new THREE.Vector3();
            child.geometry.boundingBox.getSize(sz);
            if (sz.x > 500 || sz.y > 500 || sz.z > 500) garbage.push(child);
          }
        });
        garbage.forEach(g => { if (g.parent) g.parent.remove(g); });

        if (root.userData && root.userData.zmroboMetadata && Array.isArray(root.userData.zmroboMetadata.holes)) {
          detectedHoles.push(...root.userData.zmroboMetadata.holes);
        }

        root.traverse((child) => {
          if (child.name && (child.name.startsWith('SOCKET_HOLE_') || child.name.startsWith('socket_') || child.name.startsWith('hole_'))) {
            const partsName = child.name.split('_');
            const directionToken = partsName.find(token => ['H', 'V'].includes(token.toUpperCase()));
            const userDirection = child.userData?.dir || child.userData?.type;
            const numPart = partsName.find(p => !isNaN(parseInt(p, 10)));
            const index = numPart ? parseInt(numPart, 10) : (detectedHoles.length + 1);
            const localSocketPosition = child.getWorldPosition(new THREE.Vector3())
              .applyMatrix4(inverseRootMatrix);
            const localSocketQuaternion = inverseRootQuaternion.clone()
              .multiply(child.getWorldQuaternion(new THREE.Quaternion()));
            const hasExplicitNormal = 1 - Math.abs(localSocketQuaternion.w) > 1e-6;
            const anchorNormal = new THREE.Vector3(0, 0, 1)
              .applyQuaternion(localSocketQuaternion)
              .normalize();
            const normalizedUserDirection = typeof userDirection === 'string'
              ? userDirection.toLowerCase()
              : '';
            const dir = normalizedUserDirection === 'horizontal' || normalizedUserDirection === 'vertical'
              ? normalizedUserDirection
              : directionToken
                ? (directionToken.toUpperCase() === 'H' ? 'horizontal' : 'vertical')
                : hasExplicitNormal && Math.abs(anchorNormal.y) < 0.7
                  ? 'horizontal'
                  : 'vertical';
            const normal = dir === 'horizontal' || hasExplicitNormal
              ? anchorNormal
              : new THREE.Vector3(0, 1, 0);
            const socketDescription = child.userData?.desc || `Lỗ #${index}`;
            child.userData = { isSocketNode: true, index: index, type: dir };

            const detectedIndex = detectedHoles.findIndex(h => h.index === index && h.dir === dir);
            const socketDefinition = {
              index,
              x: localSocketPosition.x,
              y: localSocketPosition.y,
              z: localSocketPosition.z,
              dir,
              normal: normal.toArray(),
              desc: socketDescription
            };
            if (detectedIndex >= 0) detectedHoles[detectedIndex] = socketDefinition;
            else detectedHoles.push(socketDefinition);
          }
          if (child.isMesh && child.material) {
            child.material.roughness = Math.max(child.material.roughness || 0.72, 0.72);
            child.material.metalness = 0.0;
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });

        detectedHoles.sort((a, b) => a.index - b.index);

        const badgeGroup = new THREE.Group();
        badgeGroup.name = "badges";
        detectedHoles.forEach(h => {
          const isH = (h.dir === 'horizontal');
          const badge = createHoleBadgeSprite(h.index, isH);
          badge.position.set(h.x, h.y + (isH ? 0.08 : 0.22), h.z + (isH ? 0.24 : 0));
          badgeGroup.add(badge);
        });
        root.add(badgeGroup);

        const cleanName = options.name || fileName.replace(/\.[^/.]+$/, "");
        const partId = options.originalId || 'glb_' + Date.now();
        const category = options.category || 'custom';
        root.userData = {
          id: partId,
          name: cleanName,
          holes: detectedHoles,
          holesCount: detectedHoles.length,
          kind: getLibraryPartKind(category),
          category,
          isPin: category === 'pins',
          pinAxis: category === 'pins' ? getModelLongitudinalAxis(root) : undefined,
          isCustomPart: true
        };

        const thumbnailData = getLibraryThumbnail(root, options.thumbnail);

        if (options.isRestoring) {
          registerCustomInventoryItem({
            id: partId,
            name: cleanName,
            category,
            holesCount: detectedHoles.length,
            modelScene: root,
            thumbnail: thumbnailData,
            sourceGLBBuffer: options.sourceGLBBuffer || null,
            sourceGLBData: options.sourceGLBData || null
          });
          options.onRestored?.(partId);
          return;
        }

        pendingGLBImport = { root, fileName, buffer, thumbnail: thumbnailData, holes: detectedHoles };
        document.getElementById('glb-import-file-name').textContent = fileName;
        document.getElementById('glb-import-name').value = cleanName;
        document.getElementById('glb-import-category').value = 'custom';
        document.getElementById('glb-import-modal').classList.remove('hidden');
        document.getElementById('glb-import-name').focus();
      }, (err) => {
        console.error(err);
        options.onRestoreError?.(err);
        if (!options.isRestoring) showToast("Không thể giải mã tệp .GLB!", "error");
      });
    }

    function registerCustomInventoryItem(item) {
      if (typeof customInventory === 'undefined') window.customInventory = [];
      
      if (customInventory.some(i => i.id === item.id)) return;

      const category = libraryItemsByCategory[item.category] ? item.category : 'custom';
      item.category = category;
      customInventory.push(item);
      libraryItemsByCategory[category].push(item);
      const emptyMotors = document.getElementById('empty-motors-msg');
      if (emptyMotors && ['motors', 'custom'].includes(category)) emptyMotors.classList.add('hidden');

      const listCategory = category === 'custom' ? 'motors' : category;
      const list = document.getElementById(`library-${listCategory}-list`);
      if (!list) return;

      const card = document.createElement('button');
      card.type = 'button';
      card.draggable = true;
      card.className = 'library-thumbnail-card library-imported-item';
      card.dataset.libraryItem = '';
      card.dataset.libraryCategory = category;
      card.dataset.libraryName = item.name;
      card.dataset.modelId = `custom:${item.id}`;
      card.dataset.sockets = String(item.holesCount || 0);
      card.title = item.name;
      card.setAttribute('aria-label', `Thêm ${item.name} vào Canvas`);
      const preview = document.createElement('img');
      preview.src = item.thumbnail || '';
      preview.alt = '';
      preview.onerror = () => { preview.src = createFallbackLibraryThumbnail(); };
      card.append(preview);
      list.appendChild(card);
      filterLibraryItems();
    }

    function getLibraryThumbnail(model, existingThumbnail) {
      if (existingThumbnail) return existingThumbnail;
      try {
        return generateGLBThumbnail(model);
      } catch (error) {
        console.warn('Không thể tạo thumbnail GLB, dùng ảnh đại diện mặc định.', error);
        return createFallbackLibraryThumbnail();
      }
    }

    const SPAWN_GAP = 2;
    const SPAWN_MARGIN = 1;
    let spawnOffset = {
      x: GRID_ORIGIN_OFFSET - GRID_BOUNDARY + SPAWN_MARGIN,
      z: GRID_ORIGIN_OFFSET - GRID_BOUNDARY + SPAWN_MARGIN,
      rowDepth: 0
    };

    function getCustomModelSpawnPosition(bounds) {
      const size = bounds.getSize(new THREE.Vector3());
      const minX = GRID_ORIGIN_OFFSET - GRID_BOUNDARY + SPAWN_MARGIN;
      const maxX = GRID_ORIGIN_OFFSET + GRID_BOUNDARY - SPAWN_MARGIN;
      const minZ = minX;
      const maxZ = GRID_ORIGIN_OFFSET + GRID_BOUNDARY - SPAWN_MARGIN;
      if (size.x > maxX - minX || size.z > maxZ - minZ) return null;

      if (!parts.some(part => part.visible)) {
        spawnOffset = { x: minX, z: minZ, rowDepth: 0 };
      }

      let x = Math.max(spawnOffset.x, minX);
      let z = Math.max(spawnOffset.z, minZ);
      let rowDepth = spawnOffset.rowDepth;

      while (true) {
        if (x + size.x > maxX) {
          x = minX;
          z += rowDepth + SPAWN_GAP;
          rowDepth = 0;
        }
        if (z + size.z > maxZ) return null;

        const candidateBounds = bounds.clone().translate(new THREE.Vector3(
          x - bounds.min.x,
          -bounds.min.y,
          z - bounds.min.z
        ));
        let nextX = x;

        for (const part of parts) {
          if (!part.visible) continue;
          part.updateMatrixWorld(true);
          const partBounds = getPartVisualBounds(part);
          if (partBounds.isEmpty()) continue;

          const overlapsZ = candidateBounds.max.z + SPAWN_GAP > partBounds.min.z &&
            candidateBounds.min.z < partBounds.max.z + SPAWN_GAP;
          const overlapsX = candidateBounds.max.x + SPAWN_GAP > partBounds.min.x &&
            candidateBounds.min.x < partBounds.max.x + SPAWN_GAP;
          if (overlapsX && overlapsZ) nextX = Math.max(nextX, partBounds.max.x + SPAWN_GAP);
        }

        if (nextX > x) {
          x = nextX;
          continue;
        }

        spawnOffset = {
          x: candidateBounds.max.x + SPAWN_GAP,
          z,
          rowDepth: Math.max(rowDepth, size.z)
        };
        return new THREE.Vector3(x - bounds.min.x, -bounds.min.y, z - bounds.min.z);
      }
    }

    function spawnFromCustomInventory(id, groundPoint = null) {
      const item = customInventory.find(x => x.id === id);
      if (!item) return;
      
      const clone = item.modelScene.clone();
      clone.position.set(0, 0, 0);
      clone.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(clone);
      if (bounds.isEmpty()) return;
      if (groundPoint) {
        placePartAtGroundPoint(clone, groundPoint);
      } else {
        const spawnPosition = getCustomModelSpawnPosition(bounds);
        if (!spawnPosition) {
          showToast('Không còn đủ chỗ trống trên lưới để thêm model này', 'error');
          return;
        }
        clone.position.copy(spawnPosition);
        clone.updateMatrixWorld(true);
      }
      clone.userData.id = 'glb_' + Date.now();
      clone.userData.name = item.name;
      clone.userData.category = item.category;
      clone.userData.kind = getLibraryPartKind(item.category);
      clone.userData.isPin = item.category === 'pins';
      if (clone.userData.isPin) clone.userData.pinAxis = item.modelScene.userData.pinAxis || [0, 1, 0];
      clone.userData.libraryItemId = item.id;
      
      scene.add(clone);
      parts.push(clone);

      selectPart(clone);
      updatePartsCount();
      if (!groundPoint) fitCameraToParts([clone]);
      recordHistoryState();
      showToast(`Đã thêm bản sao "${item.name}"`);
    }

    // ==============================================================
    // 5. EXPORT XUẤT FILE GLB
    // ==============================================================
    function exportToGLB(selectedOnly = false) {
      if (selectedOnly && !selectedPart) {
        showToast("Vui lòng chọn một linh kiện để xuất GLB riêng!", "error");
        return;
      }
      const exportGroup = new THREE.Group();
      exportGroup.name = "ZMROBO_EXPORT_ROOT";
      const partsToExport = selectedOnly ? [selectedPart] : parts;
      if (partsToExport.length === 0) {
        showToast("Không có linh kiện nào để xuất!", "error");
        return;
      }

      partsToExport.forEach(part => {
        const clonedPart = part.clone();
        const badge = clonedPart.getObjectByName("badges");
        if (badge) clonedPart.remove(badge);

        const holes = part.userData.holes || [];
        const socketGroup = new THREE.Group();
        socketGroup.name = "ZMROBO_SOCKETS";

        holes.forEach(h => {
          const anchor = new THREE.Object3D();
          const dirCode = (h.dir === 'horizontal') ? 'H' : 'V';
          anchor.name = `SOCKET_HOLE_${dirCode}_${h.index}`;
          anchor.position.set(h.x, h.y, h.z);
          const normal = Array.isArray(h.normal)
            ? new THREE.Vector3(...h.normal)
            : h.normal
              ? new THREE.Vector3(h.normal.x, h.normal.y, h.normal.z)
              : new THREE.Vector3(0, h.dir === 'horizontal' ? 0 : 1, h.dir === 'horizontal' ? 1 : 0);
          anchor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.normalize());
          anchor.userData = { index: h.index, type: h.dir, desc: h.desc };
          socketGroup.add(anchor);
        });
        clonedPart.add(socketGroup);

        clonedPart.userData.zmroboMetadata = { version: "1.0", holes: holes.map(h => ({ ...h })) };
        exportGroup.add(clonedPart);
      });

      const exporter = new THREE.GLTFExporter();
      exporter.parse(exportGroup, (gltfData) => {
        const blob = new Blob([gltfData], { type: 'model/gltf-binary' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        const fileName = selectedOnly ? `${selectedPart.userData.name || 'linh_kien'}_sockets.glb` : `lap_ghep_zmrobo_${Date.now()}.glb`;
        link.download = fileName;
        link.click();
        URL.revokeObjectURL(link.href);
        showToast(`Đã xuất file ${fileName}`);
      }, { binary: true });
    }
    gltf.scene.traverse((child) => {
      // Tìm các đối tượng được đánh dấu làm socket từ phần mềm 3D
      if (child.isObject3D && child.name.startsWith('SOCKET_HOLE_')) {
        
        // Phân định hướng dựa vào tên: Chứa '_H_' là Ngang, còn lại là Đứng
        const isHorizontal = child.name.includes('_H_');
        
        // Lấy tọa độ thế giới/cục bộ của socket
        const position = child.position.clone();

        sockets.push({
          index: sockets.length + 1,
          x: position.x,
          y: position.y,
          z: position.z,
          dir: isHorizontal ? 'horizontal' : 'vertical', // Báo cho thuật toán hít chốt biết hướng
          desc: isHorizontal ? 'Lỗ ngang' : 'Lỗ đứng'
        });
      }
    });
