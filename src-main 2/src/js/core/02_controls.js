function handleKeyboardRotation(event) {
      if (!selectedPart || event.repeat) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;

      const key = event.key.toLowerCase();
      if (event.shiftKey && key === 't') {
        event.preventDefault();
        if (!getSelectedMagneticJoint()) {
          showToast('Chọn thanh đã ghép với chốt trước', 'error');
          return;
        }

        isManualJointRotationMode = !isManualJointRotationMode;
        if (isManualJointRotationMode) setToolMode('select');
        showToast(isManualJointRotationMode
          ? 'Đã bật xoay bằng chuột: kéo ngang, mỗi nấc 5°'
          : 'Đã tắt xoay bằng chuột');
        return;
      }

      if (key === 'r') {
        event.preventDefault();
        rotateSelectedAroundJointAxis(event.shiftKey ? -1 : 1);
        return;
      }

      const rotations = {
        q: { axis: new THREE.Vector3(0, 0, 1), direction: 1 },
        e: { axis: new THREE.Vector3(0, 0, 1), direction: -1 }
      };
      const rotation = rotations[key];
      if (!rotation) return;

      event.preventDefault();
      rotateSelectedByKeyboard(rotation.axis, rotation.direction);
    }

    function rotateSelectedByKeyboard(axis, direction) {
      const part = selectedPart;
      const transformTarget = getTransformTargetForPart(part, 'rotate');
      const isPivot = transformTarget.userData.isRotationPivotGroup;
      const safe = {
        position: transformTarget.position.clone(),
        quaternion: transformTarget.quaternion.clone(),
        scale: transformTarget.scale.clone()
      };

      transformTarget.rotateOnWorldAxis(axis, direction * Math.PI / 2);
      clampPartToGround(transformTarget);
      if (!isPivot && hasPartCollision(part)) {
        transformTarget.position.copy(safe.position);
        transformTarget.quaternion.copy(safe.quaternion);
        transformTarget.scale.copy(safe.scale);
        showToast('Không thể xoay xuyên qua linh kiện khác', 'error');
        return;
      }

      transformTarget.userData.safeTransform = safe;
      recordHistoryState();
    }

    function flipPartSafely(part = selectedPart) {
      if (!part) return;

      const connectedJoints = joints.filter(joint =>
        joint.id.startsWith('magnetic_joint_') &&
        !part.userData?.isPin &&
        (joint.partA === part || joint.partB === part) &&
        joint.pin?.userData?.isPin
      );
      const connectedPins = [...new Set(connectedJoints.map(joint => joint.pin))];

      if (connectedPins.length >= 2) {
        showToast('Đã khóa cứng bởi 2 chốt, không thể lật!', 'error');
        return;
      }

      if (connectedPins.length === 1) {
        const pin = connectedPins[0];
        const joint = connectedJoints.find(item => item.pin === pin);
        const socketOnPart = joint.partA === part ? joint.socketA : joint.socketB;
        pin.updateMatrixWorld(true);
        const pinWorldAxis = getPinLongitudinalAxis(pin)
          .applyQuaternion(pin.getWorldQuaternion(new THREE.Quaternion()))
          .normalize();
        const pivotPoint = getWorldSocketPosition(part, socketOnPart);
        const angle = Math.PI / 2;
        const currentPosition = part.getWorldPosition(new THREE.Vector3());
        const offset = currentPosition.sub(pivotPoint).applyAxisAngle(pinWorldAxis, angle);
        const desiredPosition = pivotPoint.clone().add(offset);
        const rotation = new THREE.Quaternion().setFromAxisAngle(pinWorldAxis, angle);
        const desiredQuaternion = rotation.multiply(part.getWorldQuaternion(new THREE.Quaternion()));

        movePartToDesiredWorld(part, desiredPosition, desiredQuaternion);
        recordHistoryState();
        return;
      }

      const localFlip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      const desiredQuaternion = part.getWorldQuaternion(new THREE.Quaternion()).multiply(localFlip);
      movePartToDesiredWorld(part, part.getWorldPosition(new THREE.Vector3()), desiredQuaternion);
      recordHistoryState();
    }

    function getSelectedMagneticJoint() {
      return joints.find(j => j.pin && j.kinematicChild === selectedPart) ||
        joints.find(j => j.pin && (j.partA === selectedPart || j.partB === selectedPart));
    }

    function isPartLockedByMultiplePins(part) {
      const pinsByPartner = new Map();
      getConnectedPins(part).forEach(pin => {
        getPinParticipants(pin).forEach(partner => {
          if (partner === part) return;
          if (!pinsByPartner.has(partner)) pinsByPartner.set(partner, new Set());
          pinsByPartner.get(partner).add(pin);
        });
      });
      return [...pinsByPartner.values()].some(pins => pins.size >= 2);
    }

    function rotateSelectedAroundJointAxis(direction, stepDegrees = 1) {
      const part = selectedPart;
      const joint = getSelectedMagneticJoint();
      if (!joint) {
        showToast('Chi tiết chưa được ghép bằng chốt', 'error');
        return;
      }

      const pin = joint.pin;
      pin.updateMatrixWorld(true);
      const pivot = pin.getWorldPosition(new THREE.Vector3());
      const axis = new THREE.Vector3(0, 1, 0)
        .applyQuaternion(pin.getWorldQuaternion(new THREE.Quaternion()))
        .normalize();
      const angle = direction * stepDegrees * Math.PI / 180;
      const rotation = new THREE.Quaternion().setFromAxisAngle(axis, angle);
      const kinematicRoot = createRotationPivot(part, 'rotate');

      const rotationTarget = kinematicRoot || (part.parent?.userData.isAssemblyGroup && !part.parent.userData.isRotationPivotGroup
        ? part.parent
        : part);
      const worldPosition = rotationTarget.getWorldPosition(new THREE.Vector3());
      const worldQuaternion = rotationTarget.getWorldQuaternion(new THREE.Quaternion());
      const desiredPosition = worldPosition.sub(pivot).applyQuaternion(rotation).add(pivot);
      const desiredQuaternion = rotation.multiply(worldQuaternion);
      const parent = rotationTarget.parent;
      if (parent) {
        parent.updateMatrixWorld(true);
        rotationTarget.position.copy(parent.worldToLocal(desiredPosition));
        rotationTarget.quaternion.copy(parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(desiredQuaternion));
      } else {
        rotationTarget.position.copy(desiredPosition);
        rotationTarget.quaternion.copy(desiredQuaternion);
      }
      rotationTarget.updateMatrixWorld(true);
      clampPartToGround(rotationTarget);
      recordHistoryState();
    }

    function onWindowResize() {
      const container = document.getElementById('canvas-container');
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    }

    // --- THUẬT TOÁN RAYCASTER AN TOÀN TUYỆT ĐỐI (CHỈ TƯƠNG TÁC VỚI PARTS) ---
    function setupRaycaster() {
      const canvas = document.getElementById('webgl-canvas');
      const raycaster = new THREE.Raycaster();
      const mouse = new THREE.Vector2();
      const dragPlane = new THREE.Plane();
      const dragPoint = new THREE.Vector3();
      const dragOffset = new THREE.Vector3();
      let isDirectDragging = false;
      let dragStartPosition = null;
      let collisionWasBlocked = false;

      function updatePointer(event) {
        const rect = canvas.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      }

      function startDirectDrag(part, event) {
        if (toolMode !== 'select' || part !== selectedPart) return false;

        updatePointer(event);
        raycaster.setFromCamera(mouse, camera);
        const worldPosition = part.getWorldPosition(new THREE.Vector3());
        dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), worldPosition);
        if (!raycaster.ray.intersectPlane(dragPlane, dragPoint)) return false;

        dragOffset.copy(worldPosition).sub(dragPoint);
        dragStartPosition = part.position.clone();
        collisionWasBlocked = false;
        part.userData.liftedAboveAssembly = false;
        createRotationPivot(part, 'select');
        isDirectDragging = true;
        controls.enabled = false;
        canvas.setPointerCapture(event.pointerId);
        canvas.style.cursor = 'grabbing';
        part.userData.safeTransform = {
          position: part.position.clone(),
          quaternion: part.quaternion.clone(),
          scale: part.scale.clone()
        };
        return true;
      }

      canvas.addEventListener('pointermove', (event) => {
        if (!isDirectDragging || !selectedPart) return;

        updatePointer(event);
        raycaster.setFromCamera(mouse, camera);
        if (!raycaster.ray.intersectPlane(dragPlane, dragPoint)) return;

        // Vị trí thế giới tiếp theo mà con trỏ chuột muốn kéo tới
        const nextWorldPosition = dragPoint.clone().add(dragOffset);
        
        // TRỌNG TÂM FIX TẠI ĐÂY: DI CHUYỂN CẢ CỤM
        if (selectedPart.parent && selectedPart.parent.userData.isAssemblyGroup) {
          const group = selectedPart.parent;
          
          // Tính delta (độ lệch) giữa vị trí muốn tới và vị trí thế giới hiện tại của linh kiện
          const currentWorldPos = selectedPart.getWorldPosition(new THREE.Vector3());
          const positionDelta = nextWorldPosition.clone().sub(currentWorldPos);
          
          // Cộng độ lệch đó vào toàn bộ Cụm tổng
          group.position.add(positionDelta);
          group.updateMatrixWorld(true);
        } else {
          // Nếu là linh kiện tự do (không có cụm)
          if (selectedPart.parent) {
            selectedPart.position.copy(selectedPart.parent.worldToLocal(nextWorldPosition));
          } else {
            selectedPart.position.copy(nextWorldPosition);
          }
          selectedPart.updateMatrixWorld(true);
        }
        clampPartToGround(selectedPart);

        if (selectedPart.userData.isPin) {
          const snap = findNearestPinSnap(selectedPart, 2.25);
          if (snap) {
            snapPinToHole(selectedPart, snap);
            collisionWasBlocked = false;
            return;
          }
        } else {
          snapPartPositionToGrid(selectedPart);
          const snap = findNearestComponentSnap(selectedPart, 2.25);
          if (snap) {
            snapComponentToPin(selectedPart, snap);
            collisionWasBlocked = false;
            return;
          }
        }

        if (!selectedPart.userData.magneticSnapped && hasPartCollision(selectedPart, null, true)) {
          if (!liftPartAboveOverlappingAssembly(selectedPart)) {
            selectedPart.position.copy(previousPosition);
            if (!collisionWasBlocked) {
              showToast('Không thể di chuyển xuyên qua linh kiện khác', 'error');
              collisionWasBlocked = true;
            }
          } else {
            collisionWasBlocked = false;
          }
        } else {
          collisionWasBlocked = false;
        }
      });

      canvas.addEventListener('pointerup', (event) => {
        if (!isDirectDragging || !selectedPart) return;

        isDirectDragging = false;
        controls.enabled = true;
        canvas.releasePointerCapture(event.pointerId);
        canvas.style.cursor = '';

        if (!selectedPart.userData.magneticSnapped && hasPartCollision(selectedPart, null, true)) {
          selectedPart.position.copy(dragStartPosition);
          showToast('Không thể di chuyển xuyên qua linh kiện khác', 'error');
        } else if (!selectedPart.userData.liftedAboveAssembly) {
          settleAssemblyOnGround(selectedPart);
          recordHistoryState();
        } else {
          recordHistoryState();
        }
        selectedPart.userData.liftedAboveAssembly = false;
        if (rotationPivotGroup && rotationPivotPart === selectedPart) restoreRotationPivot();
        dragStartPosition = null;
        collisionWasBlocked = false;
      });

      canvas.addEventListener('pointerdown', (e) => {
        // Nếu người dùng đang thao tác kéo trục TransformControls thì không can thiệp raycaster
        if (transformControls.dragging) return;

        const rect = canvas.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);

        // QUAN TRỌNG: Chỉ raycast với danh sách parts, loại bỏ GridHelper và Gizmo planes!
        const intersects = raycaster.intersectObjects(parts, true);

        if (intersects.length > 0) {
          const hitObj = intersects[0].object;

          // Tìm xem có phải bấm vào nhãn số hay nút mỏ neo socket không
          let foundSocket = null;
          let temp = hitObj;
          while (temp && temp.parent) {
            if (temp.userData && temp.userData.isSocketNode) {
              foundSocket = temp.userData;
              break;
            }
            temp = temp.parent;
          }

          // Leo ngược lên cây phân cấp để tìm gốc part thuộc mảng parts
          let targetPart = null;
          temp = hitObj;
          while (temp) {
            if (parts.includes(temp)) {
              targetPart = temp;
              break;
            }
            temp = temp.parent;
          }

          if (targetPart) {
            const wasAlreadySelected = targetPart === selectedPart;
            selectPart(targetPart);
            if (foundSocket) {
              showToast(`Đã chọn Lỗ #${foundSocket.index} trên ${targetPart.userData.name}`);
            }
            if (wasAlreadySelected) startDirectDrag(targetPart, e);
            return;
          }
        }

        // Nếu click ra khoảng trống không trúng chi tiết nào và đang ở chế độ 'select'
        if (toolMode === 'select') selectPart(null);
      });
    }

    /// --- QUẢN LÝ CÔNG CỤ CHỌN / DI CHUYỂN / XOAY (KHÔNG BAO GIỜ BỊ ẨN) ---
    function setToolMode(mode) {
      toolMode = mode;
      
      // Giữ nguyên phần xử lý giao diện đổi màu các nút bấm UI
      ['select', 'translate', 'rotate'].forEach(m => {
        const btn = document.getElementById('btn-tool-' + m);
        if (btn) {
          if (m === mode) {
            btn.className = 'tool-btn bg-cyan-500 text-slate-950 px-3.5 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all shadow';
          } else {
            btn.className = 'tool-btn text-slate-400 hover:text-slate-200 hover:bg-slate-800 px-3.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all';
          }
        }
      });

      if (!selectedPart) {
        restoreRotationPivot();
        transformControls.detach();
        return;
      }

      if (mode === 'select') {
        restoreRotationPivot();
        transformControls.detach();
      } else {
        const targetToMove = getTransformTargetForPart(selectedPart, mode);
        transformControls.attach(targetToMove);
        transformControls.setMode(mode === 'rotate' ? 'rotate' : 'translate');
      }
    }

    // --- BỔ SUNG: HỆ THỐNG ĐIỀU KHIỂN GÓC NHÌN CAMERA MƯỢT MÀ (ĐÃ FIX LỖI KHỰNG/GIẬT ZOOM) ---
    let cameraAnimationId = null;

    function smoothMoveCamera(targetPosition, targetLookAt, duration = 800) {
      if (cameraAnimationId) cancelAnimationFrame(cameraAnimationId);

      // Tạm khóa điều khiển chuột (OrbitControls) để không xung đột với vòng lặp animation
      controls.enabled = false; 

      const startPos = camera.position.clone();
      const endPos = targetPosition.clone();
      const startTarget = controls.target.clone();
      const endTarget = targetLookAt.clone();
      
      const startTime = performance.now();

      function animateCamera(time) {
        // Đồng bộ chuẩn xác với tần số quét màn hình (60hz/144hz)
        const currentTime = time || performance.now();
        const elapsed = currentTime - startTime;
        let t = Math.min(elapsed / duration, 1);

        // Công thức Easing (Cubic In-Out): Khởi đầu êm ái, bay nhanh ở giữa, phanh mềm ở đích
        const easeT = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

        // Nội suy tọa độ
        camera.position.lerpVectors(startPos, endPos, easeT);
        controls.target.lerpVectors(startTarget, endTarget, easeT);
        
        // Ép camera cập nhật góc xoay nhìn về đích
        camera.lookAt(controls.target);
        controls.update();

        if (t < 1) {
          cameraAnimationId = requestAnimationFrame(animateCamera);
        } else {
          // Bật lại điều khiển chuột khi đã đến đích thành công
          controls.enabled = true; 
          cameraAnimationId = null;
        }
      }
      
      cameraAnimationId = requestAnimationFrame(animateCamera);
    }

    function setIsoView() {
      const center = controls.target.clone();
      const dist = camera.position.distanceTo(center) || 30;
      
      // SỬA LỖI GIẬT ZOOM: Dùng Normalize để giữ khoảng cách (Bán kính) luôn tuyệt đối bằng nhau
      const direction = new THREE.Vector3(1, 1, 1).normalize();
      const targetPos = center.clone().addScaledVector(direction, dist);
      
      smoothMoveCamera(targetPos, center, 800);
      showToast("Đã chuyển góc nhìn 3D (Iso)");
    }

    function setTopView() {
      const center = controls.target.clone();
      const dist = camera.position.distanceTo(center) || 30;
      
      // Tránh lật ngược camera bằng cách lệch trục Z đi 0.001
      const direction = new THREE.Vector3(0, 1, 0.001).normalize();
      const targetPos = center.clone().addScaledVector(direction, dist);
      
      smoothMoveCamera(targetPos, center, 800);
      showToast("Đã chuyển góc nhìn từ trên xuống (Top)");
    }

    function setFrontView() {
      const center = controls.target.clone();
      const dist = camera.position.distanceTo(center) || 30;
      
      const direction = new THREE.Vector3(0, 0, 1).normalize();
      const targetPos = center.clone().addScaledVector(direction, dist);
      
      smoothMoveCamera(targetPos, center, 800);
      showToast("Đã chuyển góc nhìn ngang (Front)");
    }

    // LẮNG NGHE PHÍM TẮT
    window.addEventListener('keydown', (event) => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

      if (event.key === 'Escape' && selectedPart) {
        const wasSeparated = separatePartFromAssembly(selectedPart);
        if (wasSeparated && typeof showToast === 'function') {
          showToast(`Đã tách ${selectedPart.userData.name || 'linh kiện'} khỏi cụm`);
        }
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedPart) {
        deleteSelectedPart();
      }
    });
