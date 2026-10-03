// --- HỆ THỐNG RAYCASTER VÀ TƯƠNG TÁC CHUỘT (ĐÃ KHÓA KHI Ở CHẾ ĐỘ REVIEW / EXPLODE) ---
    function setupRaycaster() {
      const canvas = document.getElementById('webgl-canvas');
      const raycaster = new THREE.Raycaster();
      const mouse = new THREE.Vector2();
      const dragPlane = new THREE.Plane();
      const dragPoint = new THREE.Vector3();
      const dragOffset = new THREE.Vector3();
      let isDirectDragging = false;
      let isJointRotationDragging = false;
      let jointRotationLastX = 0;
      let jointRotationRemainder = 0;
      let dragStartPosition = null;
      let dragStartQuaternion = null;
      let directDragIsKinematic = false;
      let collisionWasBlocked = false;
      let ghostMesh = null;
      let currentSnapTarget = null;
      let currentSnapType = null;
      let activeSocket = null;

      function updatePointer(event) {
        const rect = canvas.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      }

      function getActiveSocket(part, hitPoint, hintedSocket) {
        const sockets = part.userData?.holes || [];
        const hinted = hintedSocket && sockets.find(socket => socket.index === hintedSocket.index);
        if (hinted) return hinted;
        return sockets.reduce((nearest, socket) => {
          const distance = getWorldSocketPosition(part, socket).distanceToSquared(hitPoint);
          return !nearest || distance < nearest.distance ? { socket, distance } : nearest;
        }, null)?.socket || null;
      }

      function createDragGhost(part) {
        clearDragGhost();
        ghostMesh = part.clone(true);
        ghostMesh.traverse(child => {
          if (child.name === 'badges' || child.userData?.isBadge) {
            child.visible = false;
            return;
          }
          if (!child.isMesh) return;
          const makeGhostMaterial = () => new THREE.MeshBasicMaterial({
            color: 0x00ff58,
            transparent: true,
            opacity: 0.42,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide
          });
          child.material = Array.isArray(child.material)
            ? child.material.map(makeGhostMaterial)
            : makeGhostMaterial();
          child.renderOrder = 1000;
        });
        scene.add(ghostMesh);
        ghostMesh.position.copy(part.getWorldPosition(new THREE.Vector3()));
        ghostMesh.quaternion.copy(part.getWorldQuaternion(new THREE.Quaternion()));
        ghostMesh.scale.copy(part.getWorldScale(new THREE.Vector3()));
        ghostMesh.visible = false;
      }

      function clearDragGhost() {
        if (!ghostMesh) return;
        ghostMesh.traverse(child => {
          if (!child.isMesh) return;
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          materials.forEach(material => material?.dispose());
        });
        ghostMesh.parent?.remove(ghostMesh);
        ghostMesh = null;
      }

      function showSnapGhost(snap, snapType) {
        currentSnapTarget = snap;
        currentSnapType = snapType;
        if (!ghostMesh || !snap) {
          if (ghostMesh) ghostMesh.visible = false;
          return;
        }
        movePartToDesiredWorld(ghostMesh, snap.desiredWorldPosition, snap.desiredWorldQuaternion);
        ghostMesh.visible = true;
      }

      function animateToSnap(part, snap, snapType, onComplete) {
        const startPosition = part.getWorldPosition(new THREE.Vector3());
        const startQuaternion = part.getWorldQuaternion(new THREE.Quaternion());
        const targetPosition = snap.desiredWorldPosition.clone();
        const targetQuaternion = snap.desiredWorldQuaternion.clone();
        const startTime = performance.now();
        const duration = 160;

        function animateFrame(now) {
          const progress = Math.min((now - startTime) / duration, 1);
          const eased = 1 - Math.pow(1 - progress, 3);
          const position = startPosition.clone().lerp(targetPosition, eased);
          const quaternion = startQuaternion.clone().slerp(targetQuaternion, eased);
          movePartToDesiredWorld(part, position, quaternion);
          if (progress < 1) {
            requestAnimationFrame(animateFrame);
            return;
          }
          if (snapType === 'pin-to-comp') snapPinToHole(part, snap);
          else snapComponentToPin(part, snap);
          reconcileRigidAssemblies();
          onComplete();
        }

        requestAnimationFrame(animateFrame);
      }

      function finishDirectDrag(part, wasKinematicDrag) {
        clampPartToGrid(part);
        directDragIsKinematic = false;

        if (!wasKinematicDrag && !part.userData.magneticSnapped && hasPartCollision(part, null, true)) {
          movePartToDesiredWorld(part, dragStartPosition, dragStartQuaternion);
          showToast('Không thể di chuyển xuyên qua linh kiện khác', 'error');
        }
        if (!part.userData.magneticSnapped) settlePartOnSupport(part);
        if (wasKinematicDrag || part.userData.magneticSnapped) recordHistoryState();
        part.userData.liftedAboveAssembly = false;
        dragStartPosition = null;
        dragStartQuaternion = null;
        collisionWasBlocked = false;
        activeSocket = null;
        currentSnapTarget = null;
        currentSnapType = null;
      }

      function startDirectDrag(part, event) {
        if (typeof toolMode !== 'undefined' && toolMode !== 'select') return false;
        if (part !== selectedPart) return false;
        if (hasKinematicParent(part)) return false;

        updatePointer(event);
        raycaster.setFromCamera(mouse, camera);
        const worldPosition = part.getWorldPosition(new THREE.Vector3());
        dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), worldPosition);
        if (!raycaster.ray.intersectPlane(dragPlane, dragPoint)) return false;

        dragOffset.copy(worldPosition).sub(dragPoint);
        dragStartPosition = worldPosition.clone();
        dragStartQuaternion = part.getWorldQuaternion(new THREE.Quaternion());
        collisionWasBlocked = false;
        if (part.userData) part.userData.liftedAboveAssembly = false;
        currentSnapTarget = null;
        currentSnapType = null;
        createDragGhost(part);

        directDragIsKinematic = Boolean(createRotationPivot(part) ||
          (part.parent?.userData.isAssemblyGroup && !part.parent.userData.isRotationPivotGroup));
        isDirectDragging = true;
        controls.enabled = false;
        canvas.setPointerCapture(event.pointerId);
        canvas.style.cursor = 'grabbing';
        return true;
      }

      function startJointRotationDrag(event) {
        if (isPartLockedByMultiplePins(selectedPart)) {
          showToast('Thanh đã bị khóa bằng hai chốt, không thể xoay', 'error');
          return false;
        }
        isJointRotationDragging = true;
        jointRotationLastX = event.clientX;
        jointRotationRemainder = 0;
        controls.enabled = false;
        canvas.setPointerCapture(event.pointerId);
        canvas.style.cursor = 'ew-resize';
        event.preventDefault();
      }

      canvas.addEventListener('pointermove', (event) => {
        if (typeof isExploded !== 'undefined' && isExploded) return;
        if (isJointRotationDragging && selectedPart) {
          jointRotationRemainder += event.clientX - jointRotationLastX;
          jointRotationLastX = event.clientX;
          const steps = Math.trunc(jointRotationRemainder / 8);
          if (steps) {
            const direction = Math.sign(steps);
            for (let step = 0; step < Math.abs(steps); step++) {
              rotateSelectedAroundJointAxis(direction, 5);
            }
            jointRotationRemainder -= steps * 8;
          }
          return;
        }
        if (!isDirectDragging || !selectedPart) return;

        updatePointer(event);
        raycaster.setFromCamera(mouse, camera);
        if (!raycaster.ray.intersectPlane(dragPlane, dragPoint)) return;

        const nextWorldPosition = dragPoint.clone().add(dragOffset);
        const isGrouped = directDragIsKinematic || (selectedPart.parent && selectedPart.parent.userData.isAssemblyGroup);

        movePartToDesiredWorld(selectedPart, nextWorldPosition, selectedPart.getWorldQuaternion(new THREE.Quaternion()));

        if (!isGrouped && typeof clampPartToGround === 'function') {
          clampPartToGround(selectedPart);
        }
        const excludedPins = directDragIsKinematic
          ? new Set([...rotationPivotParents.keys()].filter(member => member.userData?.isPin))
          : null;
        let snap = null;
        let snapType = null;
        if (selectedPart.userData.isPin) {
          snap = findNearestPinSnap(selectedPart, 2.25, activeSocket);
          snapType = 'pin-to-comp';
          if (snap && isGrouped && snap.targetPart.parent === selectedPart.parent) snap = null;
        } else {
          snap = findNearestComponentSnap(selectedPart, 2.25, excludedPins, activeSocket);
          snapType = 'comp-to-pin';
          if (snap && isGrouped && snap.pin.parent === selectedPart.parent) snap = null;
        }
        showSnapGhost(snap, snapType);
      });

      canvas.addEventListener('pointerup', (event) => {
        if (isJointRotationDragging) {
          isJointRotationDragging = false;
          controls.enabled = true;
          if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
          canvas.style.cursor = '';
          restoreRotationPivot();
          return;
        }
        if (!isDirectDragging || !selectedPart) return;

        const part = selectedPart;
        const wasKinematicDrag = directDragIsKinematic;
        isDirectDragging = false;
        controls.enabled = true;
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        canvas.style.cursor = '';

        const excludedPins = new Set([...rotationPivotParents.keys()]
          .filter(member => member.userData?.isPin));
        let snap = currentSnapTarget;
        let snapType = currentSnapType;
        if (!snap) {
          if (part.userData.isPin) {
            snap = findNearestPinSnap(part, 2.25, activeSocket);
            snapType = 'pin-to-comp';
          } else {
            snap = findNearestComponentSnap(part, 2.25, excludedPins, activeSocket);
            snapType = 'comp-to-pin';
          }
        }
        const isGrouped = part.parent?.userData.isAssemblyGroup;
        if (snap && isGrouped && (part.userData.isPin ? snap.targetPart.parent : snap.pin.parent) === part.parent) {
          snap = null;
        }
        clearDragGhost();

        if (snap && !part.userData.isPin && wasKinematicDrag && hasKinematicParent(part)) snap = null;
        if (snap) {
          animateToSnap(part, snap, snapType, () => finishDirectDrag(part, wasKinematicDrag));
          directDragIsKinematic = false;
          return;
        }

        if (wasKinematicDrag) restoreRotationPivot();

        if (!wasKinematicDrag && part.userData.magneticSnapped) {
          const joint = joints.find(j => j.id === part.userData.magneticJointId);
          if (joint) lockIntoAssembly(joint.partA, joint.partB);
        }

        finishDirectDrag(part, wasKinematicDrag);
      });
      
      canvas.addEventListener('pointerdown', (e) => {
        if (isExploded) return; // <--- KHÓA QUAN TRỌNG: Chặn hoàn toàn thao tác click chọn vật thể khi đang ở chế độ Review (Explode)
        if (transformControls.dragging) return;

        const rect = canvas.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(parts, true);

        if (intersects.length > 0) {
          const hitObj = intersects[0].object;

          let foundSocket = null;
          let temp = hitObj;
          while (temp && temp.parent) {
            if (temp.userData && temp.userData.isSocketNode) {
              foundSocket = temp.userData;
              break;
            }
            temp = temp.parent;
          }

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
            if (isManualJointRotationMode && targetPart === selectedPart) {
              startJointRotationDrag(e);
              return;
            }

            selectPart(targetPart);
            activeSocket = getActiveSocket(targetPart, intersects[0].point, foundSocket);
            if (foundSocket) {
              showToast(`Đã chọn Lỗ #${foundSocket.index} trên ${targetPart.userData.name}`);
            }
            if (!startDirectDrag(targetPart, e)) activeSocket = null;
            return;
          }
        }

        if (toolMode === 'select') selectPart(null);
      });
    }

    // --- HỆ THỐNG SELECTION & QUẢN LÝ GIAO DIỆN LINH KIỆN ---
    function selectPart(part) {
      if (rotationPivotGroup && rotationPivotPart !== part) restoreRotationPivot();
      selectedPart = part;
      if (typeof updateJointsUI === 'function') updateJointsUI();
      const hud = document.getElementById('floating-part-hud');
      const noSelect = document.getElementById('inspector-no-selection');
      const activePanel = document.getElementById('inspector-active-panel');
      const appearanceControls = document.getElementById('appearance-controls');
      const btnDeselect = document.getElementById('btn-tool-deselect');

      updateBadgesVisibility();
      updateCanvasPartsListUI();

      if (part) {
        document.getElementById('floating-part-name').innerText = part.userData.name;
        hud.classList.remove('hidden');
        if (btnDeselect) btnDeselect.classList.remove('hidden');
        noSelect.classList.add('hidden');
        activePanel.classList.remove('hidden');
        appearanceControls.classList.remove('hidden');

        document.getElementById('inspect-part-title').innerText = part.userData.name;
        document.getElementById('inspect-part-id').innerText = `ID: ${part.userData.id}`;

        if (toolMode !== 'select') {
          attachTransformControlsForPart(part, toolMode);
        } else {
          transformControls.detach();
        }
      } else {
        hud.classList.add('hidden');
        if (btnDeselect) btnDeselect.classList.add('hidden');
        noSelect.classList.remove('hidden');
        activePanel.classList.add('hidden');
        appearanceControls.classList.add('hidden');
        transformControls.detach();
      }
    }

    function updateCanvasPartsListUI() {
      const list = document.getElementById('canvas-parts-list');
      const countBadge = document.getElementById('canvas-parts-list-count');
      if (!list) return;

      countBadge.textContent = parts.length;
      list.innerHTML = '';

      if (parts.length === 0) {
        list.innerHTML = '<div class="text-[10px] text-slate-500 py-1 text-center">Chưa có linh kiện nào trên Canvas</div>';
        return;
      }

      parts.forEach(p => {
        const isSel = (p === selectedPart);
        const item = document.createElement('div');
        item.className = `p-2 rounded-lg flex items-center justify-between transition-all cursor-pointer ${
          isSel ? 'bg-cyan-950/60 border border-cyan-400 text-cyan-200' : 'bg-slate-900 border border-slate-800 text-slate-300 hover:border-slate-700'
        }`;
        item.innerHTML = `
          <div class="min-w-0 pr-2 flex items-center gap-2" onclick="selectPartById('${p.userData.id}')">
            <div class="w-2 h-2 rounded-full ${isSel ? 'bg-cyan-400 animate-ping' : 'bg-slate-600'}"></div>
            <div class="truncate text-xs font-semibold">${p.userData.name}</div>
          </div>
          <div class="flex items-center gap-1">
            <button onclick="focusPartById('${p.userData.id}')" class="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-cyan-400" title="Căn góc nhìn vào chi tiết này">
              <i data-lucide="crosshair" class="w-3.5 h-3.5"></i>
            </button>
            <button onclick="deletePartById('${p.userData.id}')" class="p-1 rounded hover:bg-rose-950 text-slate-500 hover:text-rose-400" title="Xóa chi tiết này">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        `;
        list.appendChild(item);
      });

      if (window.lucide) window.lucide.createIcons();
    }

    function selectPartById(id) {
      const part = parts.find(p => p.userData.id === id);
      if (part) {
        selectPart(part);
        showToast(`Đã chọn "${part.userData.name}"`);
      }
    }

    function focusPartById(id) {
      const part = parts.find(p => p.userData.id === id);
      if (part) {
        selectPart(part);
        focusCurrentSelected();
      }
    }

    function deletePartById(id) {
      const part = parts.find(p => p.userData.id === id);
      if (part) {
        if (selectedPart === part) selectPart(null);
        scene.remove(part);
        parts = parts.filter(p => p !== part);
        joints = joints.filter(j => j.partA !== part && j.partB !== part);
        updateJointsUI();
        updatePartsCount();
        recordHistoryState();
        showToast(`Đã xóa "${part.userData.name}"`);
      }
    }

    function focusCurrentSelected() {
      if (selectedPart) {
        fitCameraToParts([selectedPart]);
        showToast(`Đã căn góc nhìn vào "${selectedPart.userData.name}"`);
      } else if (parts.length > 0) {
        fitCameraToParts(parts);
        showToast("Đã căn góc nhìn toàn bộ linh kiện");
      }
    }