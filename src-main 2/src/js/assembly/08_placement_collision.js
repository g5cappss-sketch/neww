    function snapPartPositionToGrid(part) {
      if (!part || part.userData?.isPin) return;

      const worldPosition = part.getWorldPosition(new THREE.Vector3());
      worldPosition.x = Math.round((worldPosition.x - GRID_ORIGIN_OFFSET) / GRID_CELL_SIZE) * GRID_CELL_SIZE + GRID_ORIGIN_OFFSET;
      worldPosition.z = Math.round((worldPosition.z - GRID_ORIGIN_OFFSET) / GRID_CELL_SIZE) * GRID_CELL_SIZE + GRID_ORIGIN_OFFSET;

      if (part.parent) {
        part.position.copy(part.parent.worldToLocal(worldPosition));
      } else {
        part.position.copy(worldPosition);
      }
    }

    function placeNewPartInEmptySpace(part) {
      if (!part) return;

      const startPosition = part.position.clone();
      const searchRadius = 12;
      const step = GRID_CELL_SIZE;

      for (let ring = 0; ring <= searchRadius; ring++) {
        const candidates = [];
        for (let x = -ring; x <= ring; x++) {
          for (let z = -ring; z <= ring; z++) {
            if (Math.max(Math.abs(x), Math.abs(z)) !== ring) continue;
            candidates.push({ x, z });
          }
        }

        for (const candidate of candidates) {
          part.position.set(
            GRID_ORIGIN_OFFSET + candidate.x * step,
            startPosition.y,
            GRID_ORIGIN_OFFSET + candidate.z * step
          );
          part.updateMatrixWorld(true);
          if (!hasPartCollision(part, null, true) && hasNewPartClearance(part)) return;
        }
      }

      part.position.copy(startPosition);
      part.updateMatrixWorld(true);
    }

    function hasNewPartClearance(part) {
      const partBox = new THREE.Box3().setFromObject(part);
      const clearance = GRID_CELL_SIZE * 2;

      for (const other of parts) {
        if (other === part || !other.visible) continue;
        other.updateMatrixWorld(true);
        const otherBox = new THREE.Box3().setFromObject(other).expandByScalar(clearance);
        if (partBox.intersectsBox(otherBox)) return false;
      }

      return true;
    }

    function placePartOnGround(part) {
      if (!part) return;
      part.updateMatrixWorld(true);
      const bounds = getPartVisualBounds(part);
      if (bounds.isEmpty() || !Number.isFinite(bounds.min.y)) return;

      part.position.y -= bounds.min.y;
      part.updateMatrixWorld(true);
    }

    function getPartVisualBounds(part) {
      const bounds = new THREE.Box3();
      part.traverse(child => {
        if (child.isMesh && !child.userData.isBadge && child.parent?.name !== 'badges') {
          bounds.expandByObject(child);
        }
      });
      return bounds;
    }

    function placePartAtGroundPoint(part, groundPoint) {
      if (!part || !groundPoint) return;
      part.updateMatrixWorld(true);
      const bounds = getPartVisualBounds(part);
      if (bounds.isEmpty()) return;

      const worldPosition = part.getWorldPosition(new THREE.Vector3());
      worldPosition.set(
        groundPoint.x,
        groundPoint.y + worldPosition.y - bounds.min.y,
        groundPoint.z
      );
      part.position.copy(part.parent ? part.parent.worldToLocal(worldPosition) : worldPosition);
      part.updateMatrixWorld(true);
      clampPartToGrid(part);
    }

    function settlePartOnSupport(part) {
      if (!part) return;

      const movingRoot = part.parent?.userData?.isAssemblyGroup ? part.parent : part;
      movingRoot.updateMatrixWorld(true);
      const movingBounds = getPartVisualBounds(movingRoot);
      if (movingBounds.isEmpty()) return;

      const rayOrigin = new THREE.Vector3(
        (movingBounds.min.x + movingBounds.max.x) / 2,
        movingBounds.max.y + 0.01,
        (movingBounds.min.z + movingBounds.max.z) / 2
      );
      const raycaster = new THREE.Raycaster(rayOrigin, new THREE.Vector3(0, -1, 0));
      const targets = parts.filter(candidate => candidate !== part && candidate.parent !== movingRoot);
      const intersections = raycaster.intersectObjects(targets, true);
      let supportY = 0;

      for (const intersection of intersections) {
        let supportPart = intersection.object;
        while (supportPart && !parts.includes(supportPart)) supportPart = supportPart.parent;
        if (!supportPart || supportPart === part || supportPart.parent === movingRoot) continue;

        const supportBounds = getPartVisualBounds(supportPart);
        if (!supportBounds.isEmpty()) {
          supportY = supportBounds.max.y;
          break;
        }
      }

      const worldPosition = movingRoot.getWorldPosition(new THREE.Vector3());
      worldPosition.y += supportY - movingBounds.min.y;
      movingRoot.position.copy(movingRoot.parent
        ? movingRoot.parent.worldToLocal(worldPosition)
        : worldPosition);
      movingRoot.updateMatrixWorld(true);
    }

    function clampPartToGrid(part) {
      if (!part) return;

      const constrainedPart = part.parent?.userData?.isAssemblyGroup || part.parent?.userData?.isRotationPivotGroup
        ? part.parent
        : part;
      constrainedPart.updateMatrixWorld(true);
      const bounds = getPartVisualBounds(constrainedPart);
      if (bounds.isEmpty()) return;

      const minX = GRID_ORIGIN_OFFSET - GRID_BOUNDARY;
      const maxX = GRID_ORIGIN_OFFSET + GRID_BOUNDARY;
      const minZ = minX;
      const maxZ = maxX;
      const size = bounds.getSize(new THREE.Vector3());
      const centerX = (minX + maxX) / 2;
      const centerZ = (minZ + maxZ) / 2;
      const offsetX = size.x > GRID_SIZE
        ? centerX - (bounds.min.x + bounds.max.x) / 2
        : bounds.min.x < minX
          ? minX - bounds.min.x
          : bounds.max.x > maxX
            ? maxX - bounds.max.x
            : 0;
      const offsetZ = size.z > GRID_SIZE
        ? centerZ - (bounds.min.z + bounds.max.z) / 2
        : bounds.min.z < minZ
          ? minZ - bounds.min.z
          : bounds.max.z > maxZ
            ? maxZ - bounds.max.z
            : 0;

      if (!offsetX && !offsetZ) return;
      const worldPosition = constrainedPart.getWorldPosition(new THREE.Vector3());
      worldPosition.x += offsetX;
      worldPosition.z += offsetZ;
      constrainedPart.position.copy(constrainedPart.parent
        ? constrainedPart.parent.worldToLocal(worldPosition)
        : worldPosition);
      constrainedPart.updateMatrixWorld(true);
    }

    function getConnectedAssemblyParts(rootPart) {
      const assembly = new Set([rootPart]);
      let changed = true;

      while (changed) {
        changed = false;
        joints.forEach(joint => {
          const connectedParts = [joint.partA, joint.partB, joint.pin].filter(Boolean);
          if (!connectedParts.some(part => assembly.has(part))) return;

          connectedParts.forEach(part => {
            if (!assembly.has(part)) {
              assembly.add(part);
              changed = true;
            }
          });
        });
      }

      return [...assembly].filter(part => part && part.parent);
    }

    function settleAssemblyOnGround(rootPart) {
      if (!rootPart) return;
      const assembly = getConnectedAssemblyParts(rootPart);
      const assemblyBounds = new THREE.Box3();

      assembly.forEach(part => {
        part.updateMatrixWorld(true);
        assemblyBounds.union(getPartVisualBounds(part));
      });

      if (assemblyBounds.isEmpty() || !Number.isFinite(assemblyBounds.min.y)) return;
      const verticalOffset = -assemblyBounds.min.y;
      if (Math.abs(verticalOffset) < 0.0001) return;

      assembly.forEach(part => {
        part.position.y += verticalOffset;
        part.updateMatrixWorld(true);
      });
    }

    // --- BỘ CÔNG CỤ XỬ LÝ VA CHẠM VÀ VẬT LÝ (ĐÃ FIX LỖI LẬT NGƯỢC XUYÊN VẬT THỂ) ---

    // 1. Hàm kiểm tra va chạm cực kỳ chính xác (Chỉ tính lưới Mesh, bỏ qua Sprites/Nhãn số)
    function hasPartCollision(part, ignorePart = null, includeAllPartTypes = false) {
      if (!part || !part.parent || !parts.length) return false;

      part.updateMatrixWorld(true);
      // SỬ DỤNG getPartVisualBounds thay vì setFromObject để loại bỏ rác từ Sprite
      const selfBox = getPartVisualBounds(part); 

      for (const other of parts) {
        if (other === part || other === ignorePart) continue;
        if (!other.visible) continue;
        if (!includeAllPartTypes && part.userData?.isPin !== other.userData?.isPin) continue;
        
        other.updateMatrixWorld(true);
        const otherBox = getPartVisualBounds(other);
        
        const hasVolumeOverlap = selfBox.max.x > otherBox.min.x + COLLISION_TOLERANCE &&
          selfBox.min.x < otherBox.max.x - COLLISION_TOLERANCE &&
          selfBox.max.y > otherBox.min.y + COLLISION_TOLERANCE &&
          selfBox.min.y < otherBox.max.y - COLLISION_TOLERANCE &&
          selfBox.max.z > otherBox.min.z + COLLISION_TOLERANCE &&
          selfBox.min.z < otherBox.max.z - COLLISION_TOLERANCE;
          
        if (hasVolumeOverlap) {
          return true;
        }
      }
      return false;
    }

    // 2. Hàm nâng vật thể lên khi đè đâm vào vật thể khác
    function liftPartAboveOverlappingAssembly(part) {
      if (!part || part.userData?.isPin) return false;

      part.updateMatrixWorld(true);
      const partBox = getPartVisualBounds(part);
      let highestTop = null;

      for (const other of parts) {
        if (other === part || !other.visible || other.userData?.isPin) continue;
        other.updateMatrixWorld(true);
        const otherBox = getPartVisualBounds(other);
        
        const overlapsHorizontally = partBox.max.x > otherBox.min.x + COLLISION_TOLERANCE &&
          partBox.min.x < otherBox.max.x - COLLISION_TOLERANCE &&
          partBox.max.z > otherBox.min.z + COLLISION_TOLERANCE &&
          partBox.min.z < otherBox.max.z - COLLISION_TOLERANCE;
          
        if (overlapsHorizontally && (highestTop === null || otherBox.max.y > highestTop)) {
          highestTop = otherBox.max.y;
        }
      }

      if (highestTop === null) return false;

      const liftAmount = highestTop + GRID_CELL_SIZE * 0.12 - partBox.min.y;
      if (liftAmount <= 0) return false;

      const worldPosition = part.getWorldPosition(new THREE.Vector3());
      worldPosition.y += liftAmount;
      part.position.copy(part.parent.worldToLocal(worldPosition));
      part.updateMatrixWorld(true);
      part.userData.liftedAboveAssembly = true;
      return true;
    }

    // 3. Hàm chặn vật thể không bị rớt xuyên qua mặt đất (Fix triệt để lỗi úp/xoay dọc)
    function getGroundConstraintRoot(part) {
      let current = part;
      let assemblyRoot = null;
      while (current) {
        if (current.userData?.isRotationPivotGroup) return current;
        if (current.userData?.isAssemblyGroup) assemblyRoot = current;
        current = current.parent;
      }
      return assemblyRoot || part;
    }

    function clampPartToGround(part) {
      if (!part) return;

      const root = getGroundConstraintRoot(part);
      root.updateMatrixWorld(true);
      
      // Tính toán hộp bao quát thực tế của hình học ở bất kỳ góc xoay nào
      const bounds = getPartVisualBounds(root);
      if (bounds.isEmpty() || !Number.isFinite(bounds.min.y) || bounds.min.y >= 0) return;
      
      // Nếu phần thấp nhất (đáy) của vật thể chìm dưới y = 0, đẩy ngược toàn bộ lên trên mặt đất
      const worldPosition = root.getWorldPosition(new THREE.Vector3());
      worldPosition.y -= bounds.min.y;
      root.position.copy(root.parent
        ? root.parent.worldToLocal(worldPosition)
        : worldPosition);
      root.updateMatrixWorld(true);
    }

    function wouldPartTransformGoBelowGround(part, desiredWorldPosition, desiredWorldQuaternion) {
      if (!part || !desiredWorldPosition || !desiredWorldQuaternion) return false;

      const root = getGroundConstraintRoot(part);
      root.updateMatrixWorld(true);
      part.updateMatrixWorld(true);

      const currentWorldPosition = part.getWorldPosition(new THREE.Vector3());
      const rotationDelta = desiredWorldQuaternion.clone()
        .multiply(part.getWorldQuaternion(new THREE.Quaternion()).invert())
        .normalize();
      const corner = new THREE.Vector3();
      let lowestY = Infinity;

      root.traverse(child => {
        if (!child.isMesh || child.userData.isBadge || child.parent?.name === 'badges') return;
        if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
        const box = child.geometry.boundingBox;
        if (!box) return;

        for (let x = 0; x <= 1; x++) {
          for (let y = 0; y <= 1; y++) {
            for (let z = 0; z <= 1; z++) {
              corner.set(
                x ? box.max.x : box.min.x,
                y ? box.max.y : box.min.y,
                z ? box.max.z : box.min.z
              ).applyMatrix4(child.matrixWorld);
              corner.sub(currentWorldPosition)
                .applyQuaternion(rotationDelta)
                .add(desiredWorldPosition);
              lowestY = Math.min(lowestY, corner.y);
            }
          }
        }
      });

      return Number.isFinite(lowestY) && lowestY < -0.0001;
    }

    // 4. Kiểm tra xem vùng không gian có trống để Spawn (sinh) vật thể mới không
    function hasNewPartClearance(part) {
      part.updateMatrixWorld(true);
      const partBox = getPartVisualBounds(part);
      const clearance = GRID_CELL_SIZE * 2;

      for (const other of parts) {
        if (other === part || !other.visible) continue;
        other.updateMatrixWorld(true);
        
        // Mở rộng vùng bao của vật thể xung quanh ra một khoảng an toàn
        const otherBox = getPartVisualBounds(other).expandByScalar(clearance);
        if (partBox.intersectsBox(otherBox)) return false;
      }
      return true;
    }

