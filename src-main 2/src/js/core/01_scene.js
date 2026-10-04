    // --- HỘP THÔNG BÁO TOAST UI ---
    let toastTimeoutId = null;

    function showToast(message, type = 'success') {
      const toast = document.getElementById('toast-notification');
      const msg = document.getElementById('toast-message');
      if (!toast || !msg) return;

      msg.textContent = message;
      toast.dataset.type = type;
      toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
      toast.classList.remove('hidden');
      requestAnimationFrame(() => toast.classList.add('is-visible'));
      clearTimeout(toastTimeoutId);
      toastTimeoutId = setTimeout(() => {
        toast.classList.remove('is-visible');
        toastTimeoutId = setTimeout(() => toast.classList.add('hidden'), 180);
      }, type === 'error' ? 3600 : 2400);
    }

    // --- KHỞI TẠO 3D SCENE ---
    function init3D() {
      const container = document.getElementById('canvas-container');
      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x05070c);

      selectedPartHitbox = new THREE.Box3Helper(new THREE.Box3(), 0x22d3ee);
      selectedPartHitbox.material.depthTest = false;
      selectedPartHitbox.renderOrder = 10;
      selectedPartHitbox.visible = false;
      scene.add(selectedPartHitbox);

      camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
      camera.position.set(10, 12, 16);

      renderer = new THREE.WebGLRenderer({ 
        canvas: document.getElementById('webgl-canvas'), 
        antialias: true, 
        powerPreference: "high-performance" 
      });
      renderer.setSize(container.clientWidth, container.clientHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;

      controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.05;

      transformControls = new THREE.TransformControls(camera, renderer.domElement);
      transformControls.addEventListener('dragging-changed', (e) => {
        controls.enabled = !e.value;
        if (selectedPart) {
          const transformTarget = getTransformTargetForPart(selectedPart, toolMode);
          if (!transformTarget) {
            transformControls.detach();
            controls.enabled = true;
            return;
          }
          if (e.value) {
            transformTarget.userData.safeTransform = {
              position: transformTarget.position.clone(),
              quaternion: transformTarget.quaternion.clone(),
              scale: transformTarget.scale.clone()
            };
          } else if (!transformTarget.userData.isRotationPivotGroup && hasPartCollision(selectedPart)) {
            const safe = transformTarget.userData.safeTransform || { position: transformTarget.position.clone(), quaternion: transformTarget.quaternion.clone(), scale: transformTarget.scale.clone() };
            transformTarget.position.copy(safe.position);
            transformTarget.quaternion.copy(safe.quaternion);
            transformTarget.scale.copy(safe.scale);
            showToast("Không thể di chuyển xuyên qua linh kiện khác", "error");
          }
        }
      });
      transformControls.addEventListener('objectChange', () => {
        if (selectedPart) {
          const transformTarget = getTransformTargetForPart(selectedPart, toolMode);
          if (!transformTarget) {
            transformControls.detach();
            showToast('Cụm đã bị khóa cứng tĩnh học, không thể xoay', 'error');
            return;
          }
          if (toolMode === 'rotate' && !canRotateWholeRigidCluster(selectedPart, transformTarget)) {
            const safe = transformTarget.userData.safeTransform;
            if (safe) {
              transformTarget.position.copy(safe.position);
              transformTarget.quaternion.copy(safe.quaternion);
              transformTarget.scale.copy(safe.scale);
            }
            showToast('Không thể xoay riêng một phần của cụm cứng', 'error');
            return;
          }
          if (!transformTarget.userData.isRotationPivotGroup) {
            settleAssemblyOnGround(transformTarget);
            snapPartPositionToGrid(transformTarget);
          }
          clampPartToGrid(transformTarget);
          clampPartToGround(transformTarget);
          if (!transformTarget.userData.isRotationPivotGroup && hasPartCollision(selectedPart)) {
            const safe = transformTarget.userData.safeTransform || { position: transformTarget.position.clone(), quaternion: transformTarget.quaternion.clone(), scale: transformTarget.scale.clone() };
            transformTarget.position.copy(safe.position);
            transformTarget.quaternion.copy(safe.quaternion);
            transformTarget.scale.copy(safe.scale);
            showToast("Không thể di chuyển xuyên qua linh kiện khác", "error");
            return;
          }
          transformTarget.userData.safeTransform = {
            position: transformTarget.position.clone(),
            quaternion: transformTarget.quaternion.clone(),
            scale: transformTarget.scale.clone()
          };
        }
        recordHistoryState();
      });
      scene.add(transformControls);

      axesHelper = new THREE.AxesHelper(4);
      axesHelper.visible = false;
      scene.add(axesHelper);

      // Hệ thống ánh sáng Studio cân bằng
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
      scene.add(ambientLight);

      const dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
      dirLight.position.set(12, 20, 14);
      dirLight.castShadow = true;
      dirLight.shadow.mapSize.width = 2048;
      dirLight.shadow.mapSize.height = 2048;
      dirLight.shadow.bias = -0.0001;
      scene.add(dirLight);

      const fillLight = new THREE.DirectionalLight(0x38bdf8, 0.35);
      fillLight.position.set(-10, 10, -10);
      scene.add(fillLight);

      const grid = new THREE.GridHelper(50 * GRID_CELL_SIZE, 50, 0x0284c7, 0x1e293b);
      grid.position.set(GRID_ORIGIN_OFFSET, -0.01, GRID_ORIGIN_OFFSET);
      scene.add(grid);

      setupRaycaster();
      setupDragDrop();
      setupFileInputs();
      setupMobileSidebar();
      window.addEventListener('resize', onWindowResize);
      window.addEventListener('keydown', handleKeyboardRotation);

      transformControls.rotationSnap = Math.PI / 4;
      transformControls.translationSnap = GRID_CELL_SIZE;

      // Cập nhật giao diện toolbar ban đầu
      setToolMode('select');

      // (ĐÃ XÓA dòng spawnTechnicBeam mặc định để canvas trống)
      // spawnTechnicBeam(7, 0x94a3b8, 'Dầm Kỹ Thuật');
      
      // KHỞI TẠO LỊCH SỬ TRỐNG RỖNG BAN ĐẦU
      history = [];
      historyIndex = -1;
      updateHistoryButtons(); // Làm mờ 2 nút Trước / Sau ngay từ đầu

      animate()
    }

