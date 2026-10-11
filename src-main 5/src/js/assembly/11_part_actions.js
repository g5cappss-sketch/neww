    function duplicateSelectedPart() {
      if (!selectedPart) return;
      const clone = selectedPart.clone();
      clone.position.x += 1.0;
      clone.position.z += 1.0;
      clone.userData = JSON.parse(JSON.stringify(selectedPart.userData));
      clone.userData.id = 'part_' + Date.now();

      scene.add(clone);
      parts.push(clone);
      selectPart(clone);
      updatePartsCount();
      recordHistoryState();
      showToast('Đã nhân bản chi tiết');
    }

    function deleteSelectedPart() {
      if (!selectedPart) return;
      const partToDelete = selectedPart;
      selectPart(null);
        partToDelete.parent?.remove(partToDelete);
      parts = parts.filter(p => p !== partToDelete);
        joints = joints.filter(j => j.partA !== partToDelete && j.partB !== partToDelete && j.pin !== partToDelete);
      updateJointsUI();
      updatePartsCount();
      recordHistoryState();
      showToast('Đã xóa chi tiết');
    }

    function clearAllParts(options = {}) {
      const { skipHistory = false } = options;
      parts.forEach(p => scene.remove(p));
      parts = [];
      joints = [];
      selectPart(null);
      updateJointsUI();
      updatePartsCount();
      if (!skipHistory) {
        recordHistoryState();
        showToast('Đã dọn sạch toàn bộ linh kiện');
      }
    }

    function updatePartsCount() {
      document.getElementById('badge-parts-count').textContent = `${parts.length} Linh kiện`;
      updateCanvasPartsListUI();
      updateJointsUI();
    }

    function setCameraView(view) {
      const target = selectedPart ? selectedPart.position : new THREE.Vector3(0, 0, 0);
      const dist = 14;
      if (view === 'iso') camera.position.set(target.x + dist, target.y + dist, target.z + dist);
      else if (view === 'top') camera.position.set(target.x, target.y + dist * 1.5, target.z + 0.001);
      else if (view === 'front') camera.position.set(target.x, target.y, target.z + dist * 1.5);
      camera.lookAt(target);
      controls.target.copy(target);
      controls.update();
    }

    function toggleAutoRotate() {
      isAutoRotate = !isAutoRotate;
      controls.autoRotate = isAutoRotate;
      controls.autoRotateSpeed = 2.0;
      document.getElementById('toggle-autorotate').classList.toggle('text-cyan-400', isAutoRotate);
    }

    let isAnimatingExplode = false; // Biến khóa để tránh bấm liên tục khi đang chạy animation

    function toggleAssemblyExplode() {
      if (isAnimatingExplode) return; // Nếu đang chạy animation thì bỏ qua

      const targetIsExploded = !isExploded;
      isAnimatingExplode = true;

      // 1. Nếu bắt đầu tách (Explode) -> Khóa ngay lập tức giao diện chỉnh sửa
      if (targetIsExploded) {
        selectPart(null); 
        if (transformControls) transformControls.detach();
      }

      // 2. Tính toán tâm của toàn bộ cụm lắp ghép để làm mốc văng ra
      const assemblyBox = new THREE.Box3();
      parts.forEach(p => assemblyBox.expandByObject(p));
      const center = new THREE.Vector3();
      assemblyBox.getCenter(center);

      const animations = [];

      parts.forEach((p, idx) => {
        let startPos = p.position.clone();
        let startRot = p.quaternion.clone();
        let targetPos, targetRot;

        if (targetIsExploded) {
          // Lưu lại vị trí gốc nếu chưa lưu
          if (!p.userData.originPos) {
            p.userData.originPos = p.position.clone();
            p.userData.originRot = p.quaternion.clone();
          }
          startPos = p.userData.originPos.clone();
          startRot = p.userData.originRot.clone();

          // Tính toán hướng văng ra từ tâm
          const partBox = new THREE.Box3().setFromObject(p);
          const partCenter = new THREE.Vector3();
          partBox.getCenter(partCenter);

          const dir = new THREE.Vector3().subVectors(partCenter, center);
          if (dir.length() < 0.01) {
            dir.set(0, 1, 0);
          } else {
            dir.normalize();
          }

          const explodeDistance = 4.0;
          targetPos = startPos.clone().add(dir.multiplyScalar(explodeDistance));
          targetRot = startRot.clone();

          // Nếu là chốt, nhấc bứt hẳn lên trên theo trục Y
          if (p.userData.isPin || p.userData.isJoinPin) {
            targetPos.y += 2.5;
          }
        } else {
          // Khi thu gom: Đích đến là vị trí gốc ban đầu
          startPos = p.position.clone();
          startRot = p.quaternion.clone();
          targetPos = p.userData.originPos ? p.userData.originPos.clone() : p.position.clone();
          targetRot = p.userData.originRot ? p.userData.originRot.clone() : p.quaternion.clone();
        }

        animations.push({
          part: p,
          startPos,
          targetPos,
          startRot,
          targetRot
        });
      });

      // Cập nhật trạng thái cờ và giao diện nút bấm
      isExploded = targetIsExploded;
      document.getElementById('label-explode').textContent = isExploded ? 'Thu gom (Assemble)' : 'Tách rời (Explode)';
      document.getElementById('btn-explode').classList.toggle('bg-amber-500/20', isExploded);
      document.getElementById('btn-explode').classList.toggle('text-amber-300', isExploded);

      // 3. Chạy vòng lặp Animation mượt mà (Thời gian: 650 mili-giây)
      const duration = 650; 
      const startTime = performance.now();

      function animateFrame(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1.0);
        
        // Hàm toán học tạo hiệu ứng trượt chậm dần về cuối (Cubic Ease-Out)
        const easeProgress = 1 - Math.pow(1 - progress, 3);

        animations.forEach(anim => {
          anim.part.position.lerpVectors(anim.startPos, anim.targetPos, easeProgress);
          anim.part.quaternion.slerpQuaternions(anim.startRot, anim.targetRot, easeProgress);
        });

        if (progress < 1.0) {
          requestAnimationFrame(animateFrame);
        } else {
          // Khi animation chạy xong
          isAnimatingExplode = false;
          if (!isExploded) {
            // Xóa mốc tạm sau khi đã thu gom xong để mở khóa chỉnh sửa
            parts.forEach(p => {
              delete p.userData.originPos;
              delete p.userData.originRot;
            });
            showToast('Đã thu gom về vị trí cũ (Mở khóa chỉnh sửa)');
          } else {
            showToast('Đã vào chế độ Review (Đã khóa chỉnh sửa)');
          }
        }
      }

      requestAnimationFrame(animateFrame);
    }

    function inferPartKind(part) {
      if (part.userData?.isPin) return 'pin';
      if (part.userData?.name?.includes('Nẹp') || part.userData?.kind === 'yellow-bracket') return 'yellow-bracket';
      if (part.userData?.name?.includes('Thanh DV') || part.userData?.kind === 'dv-bar') return 'dv-bar';
      return part.userData?.kind || 'beam';
    }

