    function createHoleBadgeSprite(number, isHorizontal = false) {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext('2d');

      ctx.clearRect(0, 0, 256, 256);

      // Đổ bóng ngoài (Drop Shadow)
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 7;

      // Viền tròn trắng ngoài cùng
      ctx.beginPath();
      ctx.arc(128, 128, 110, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();

      // Viền mạ bạc
      ctx.beginPath();
      ctx.arc(128, 128, 110, 0, Math.PI * 2);
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#e2e8f0';
      ctx.stroke();

      // Vòng tròn màu chính bên trong (Gradient 3D)
      ctx.beginPath();
      ctx.arc(128, 128, 94, 0, Math.PI * 2);
      const grad = ctx.createLinearGradient(128, 34, 128, 222);
      if (isHorizontal) {
        grad.addColorStop(0, '#818cf8');
        grad.addColorStop(0.45, '#6366f1');
        grad.addColorStop(1, '#4338ca');
      } else {
        grad.addColorStop(0, '#38bdf8');
        grad.addColorStop(0.45, '#0284c7');
        grad.addColorStop(1, '#0369a1');
      }
      ctx.fillStyle = grad;
      ctx.fill();

      // Ánh sáng phản chiếu bóng vòm trên (Specular Highlight)
      ctx.beginPath();
      ctx.arc(128, 128, 91, Math.PI * 1.12, Math.PI * 1.88, false);
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.stroke();

      // Số thứ tự ở giữa (To, đậm và nổi bật)
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 108px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 4;
      ctx.fillText(number.toString(), 128, 132);

      const texture = new THREE.CanvasTexture(canvas);
      texture.minFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;

      const spriteMat = new THREE.SpriteMaterial({
        map: texture,
        depthTest: false,
        depthWrite: false,
        transparent: true
      });

      const baseScale = 0.82;
      const sprite = new THREE.Sprite(spriteMat);
      sprite.scale.set(baseScale, baseScale, 1);
      sprite.userData = { isBadge: true, baseScale: baseScale, isSocketNode: true, index: number };
      return sprite;
    }

    function updateBadgesVisibility() {
      parts.forEach(p => {
        const bg = p.getObjectByName("badges");
        if (bg) {
          if (badgesMode === 'none') {
            bg.visible = false;
          } else if (badgesMode === 'all') {
            bg.visible = true;
          } else {
            bg.visible = (p === selectedPart);
          }

          if (p !== selectedPart) {
            bg.children.forEach(b => {
              if (b.userData && b.userData.baseScale) {
                b.scale.set(b.userData.baseScale, b.userData.baseScale, 1);
              }
              if (b.material) b.material.opacity = 1.0;
            });
          }
        }
      });
    }

    function setBadgesMode(mode) {
      if (!['selected', 'all', 'none'].includes(mode)) return;
      badgesMode = mode;
      document.querySelectorAll('[data-badges-mode]').forEach(button => {
        const isActive = button.dataset.badgesMode === mode;
        button.setAttribute('aria-pressed', String(isActive));
        button.classList.toggle('is-selected', isActive);
        button.classList.toggle('bg-slate-800', isActive);
        button.classList.toggle('text-slate-200', isActive);
        button.classList.toggle('text-slate-300', !isActive);
        button.querySelector('.mode-check')?.classList.toggle('hidden', !isActive);
      });
      updateBadgesVisibility();
    }

    function setHitboxVisibility(visible) {
      isHitboxVisible = Boolean(visible);
      if (selectedPartHitbox) selectedPartHitbox.visible = isHitboxVisible && Boolean(selectedPart) && !isExploded;
    }

    function animate() {
      requestAnimationFrame(animate);

      if (selectedPartHitbox) {
        if (selectedPart && !isExploded) {
          selectedPart.updateMatrixWorld(true);
          selectedPartHitbox.box.copy(getPartVisualBounds(selectedPart));
          selectedPartHitbox.visible = isHitboxVisible && !selectedPartHitbox.box.isEmpty();
        } else {
          selectedPartHitbox.visible = false;
        }
      }

      // Hiệu ứng nhấp nháy / thở (Pulsing) cho chi tiết đang chọn
      if (selectedPart) {
        const bg = selectedPart.getObjectByName("badges");
        if (bg && bg.visible) {
          const time = Date.now() * 0.007;
          const pulseScale = 1.0 + 0.09 * Math.sin(time);
          const pulseOpacity = 0.84 + 0.16 * Math.cos(time);

          bg.children.forEach(b => {
            if (b.userData && b.userData.baseScale) {
              const currentScale = b.userData.baseScale * pulseScale;
              b.scale.set(currentScale, currentScale, 1);
            }
            if (b.material) {
              b.material.opacity = pulseOpacity;
            }
          });
        }
      }

      // Bảo vệ chống tràn camera
      if (isNaN(camera.position.x) || isNaN(camera.position.y) || isNaN(camera.position.z) || camera.position.length() > 300) {
        camera.position.set(10, 12, 16);
        controls.target.set(0, 0, 0);
        controls.update();
      }

      if (controls) controls.update();
      renderer.render(scene, camera);
    }

    function fitCameraToParts(partsList = parts) {
      if (!partsList || partsList.length === 0) {
        camera.position.set(10, 12, 16);
        camera.lookAt(0, 0, 0);
        controls.target.set(0, 0, 0);
        controls.update();
        return;
      }

      const box = new THREE.Box3();
      let validMeshCount = 0;

      partsList.forEach(part => {
        if (!part) return;
        part.traverse(child => {
          if (child.isMesh && !child.userData.isBadge && child.geometry) {
            const childBox = new THREE.Box3().setFromObject(child);
            if (!isNaN(childBox.min.x) && isFinite(childBox.min.x) &&
                !isNaN(childBox.max.x) && isFinite(childBox.max.x)) {
              const sz = new THREE.Vector3();
              childBox.getSize(sz);
              if (sz.x < 100 && sz.y < 100 && sz.z < 100) {
                box.union(childBox);
                validMeshCount++;
              }
            }
          }
        });
      });

      if (validMeshCount === 0 || box.isEmpty()) {
        camera.position.set(10, 12, 16);
        camera.lookAt(0, 0, 0);
        controls.target.set(0, 0, 0);
        controls.update();
        return;
      }

      const sphere = box.getBoundingSphere(new THREE.Sphere());
      if (isNaN(sphere.radius) || !isFinite(sphere.radius) || sphere.radius <= 0) {
        camera.position.set(10, 12, 16);
        camera.lookAt(0, 0, 0);
        controls.target.set(0, 0, 0);
        controls.update();
        return;
      }

      const center = sphere.center;
      const radius = Math.min(Math.max(sphere.radius, 2.5), 25.0);
      const fovRad = (camera.fov * Math.PI) / 360;
      let dist = (radius / Math.sin(fovRad)) * 1.15;
      dist = Math.min(Math.max(dist, 5.0), 35.0);

      camera.position.set(center.x + dist * 0.7, center.y + dist * 0.65, center.z + dist * 0.85);
      camera.lookAt(center);
      controls.target.copy(center);
      controls.update();
    }

    function createRealisticBeamGeometry(holesCount, height = BEAM_HEIGHT) {
      const shape = new THREE.Shape();
      const halfLen = ((holesCount - 1) * DV) / 2;
      const r = 0.5 * DV;

      shape.absarc(halfLen, 0, r, -Math.PI / 2, Math.PI / 2, false);
      shape.absarc(-halfLen, 0, r, Math.PI / 2, 3 * Math.PI / 2, false);
      shape.closePath();

      for (let i = 0; i < holesCount; i++) {
        const x = -halfLen + i * DV;
        const holePath = new THREE.Path();
        holePath.absarc(x, 0, HOLE_RADIUS, 0, Math.PI * 2, true);
        shape.holes.push(holePath);
      }

      const geom = new THREE.ExtrudeGeometry(shape, {
        steps: 1,
        depth: height,
        bevelEnabled: true,
        bevelThickness: 0.025,
        bevelSize: 0.025,
        bevelSegments: 3
      });
      geom.center();
      geom.rotateX(Math.PI / 2);
      return { geom, halfLen };
    }

