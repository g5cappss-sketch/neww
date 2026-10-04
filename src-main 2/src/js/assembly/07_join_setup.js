
    function beginJoinObjectPick(slot) {
      pickJoinMode = slot;
      const banner = document.getElementById('snap-guide-banner');
      const bannerText = document.getElementById('snap-guide-text');
      banner.classList.remove('hidden');
      bannerText.innerText = slot === 'first' ? 'Nhấp chuột vào Đối tượng 1 trên màn hình 3D...' : 'Nhấp chuột vào Đối tượng 2 trên màn hình 3D...';
    }

    function cancelSnapMode() {
      pickJoinMode = null;
      document.getElementById('snap-guide-banner').classList.add('hidden');
    }

    function updateJoinWizardUI() {
      document.getElementById('join-object-first').innerText = pickedFirstPart ? pickedFirstPart.userData.name : 'Chưa chọn';
      document.getElementById('join-object-second').innerText = pickedSecondPart ? pickedSecondPart.userData.name : 'Chưa chọn';

      const select1 = document.getElementById('join-socket-first');
      const select2 = document.getElementById('join-socket-second');
      select1.innerHTML = '';
      select2.innerHTML = '';

      if (pickedFirstPart && pickedFirstPart.userData.holes) {
        pickedFirstPart.userData.holes.forEach(h => {
          const opt = document.createElement('option');
          opt.value = h.index;
          opt.textContent = `Lỗ #${h.index} (${h.dir === 'horizontal' ? 'Ngang' : 'Đứng'})`;
          select1.appendChild(opt);
        });
      }

      if (pickedSecondPart && pickedSecondPart.userData.holes) {
        pickedSecondPart.userData.holes.forEach(h => {
          const opt = document.createElement('option');
          opt.value = h.index;
          opt.textContent = `Lỗ #${h.index} (${h.dir === 'horizontal' ? 'Ngang' : 'Đứng'})`;
          select2.appendChild(opt);
        });
      }
    }

