const MAX_MAGNETIC_SNAP_DISTANCE = Math.max(HOLE_RADIUS * 2.8, GRID_CELL_SIZE * 1.5);
const SOCKET_ENTRY_PROBE_RADIUS = HOLE_RADIUS * 0.8;
const MIN_SOCKET_INSERTION_DEPTH = Math.max(HOLE_RADIUS * 1.4, 0.35);
const SOCKET_RAY_START_OFFSET = Math.max(HOLE_RADIUS * 0.2, 0.025);
const SEATED_PIN_SOCKET_TOLERANCE = Math.max(HOLE_RADIUS * 0.6, 0.16);
const socketRaycastMeshesCache = new WeakMap();
let magneticJointSequence = 0;
let pendingPinStraightening = new Set();

function createMagneticJointId() {
  magneticJointSequence += 1;
  return `magnetic_joint_${Date.now()}_${magneticJointSequence}`;
}

function isMagneticPinPart(part) {
  const data = part?.userData;
  const kind = String(data?.kind || '').trim().toLowerCase();
  const category = String(data?.category || '').trim().toLowerCase();
  return Boolean(data?.isPin || data?.isJoinPin || kind === 'pin' || category === 'pins');
}

function getWorldSocketPosition(part, socket) {
      part.updateMatrixWorld(true);
      return new THREE.Vector3(socket.x, socket.y, socket.z).applyMatrix4(part.matrixWorld);
    }

    function getLocalHoleCenter(socket) {
      const center = new THREE.Vector3(socket.x, socket.y, socket.z);
      if (isVerticalSocket(socket)) center.y -= socket.y * 2;
      return center;
    }

    function getWorldHoleCenter(part, socket) {
      const surfacePosition = getWorldSocketPosition(part, socket);
      if (!isVerticalSocket(socket) || Math.abs(socket.y) < 0.001) return surfacePosition;

      const inwardOffset = new THREE.Vector3(0, socket.y * 2, 0)
        .applyQuaternion(part.getWorldQuaternion(new THREE.Quaternion()));
      return surfacePosition.sub(inwardOffset);
    }

    function getComponentSnapPosition(part, componentSocket, pinSocket) {
      return pinSocket.y < 0
        ? getWorldHoleCenter(part, componentSocket)
        : getWorldSocketPosition(part, componentSocket);
    }

    function getLocalComponentSnapPosition(componentSocket, pinSocket) {
      return pinSocket.y < 0
        ? getLocalHoleCenter(componentSocket)
        : new THREE.Vector3(componentSocket.x, componentSocket.y, componentSocket.z);
    }

    function getPinLongitudinalAxis(pin) {
      const axis = pin.userData?.pinAxis;
      if (Array.isArray(axis)) return new THREE.Vector3(...axis).normalize();
      if (axis && typeof axis === 'object') return new THREE.Vector3(axis.x, axis.y, axis.z).normalize();
      return new THREE.Vector3(0, 1, 0);
    }

    function getPinInsertionAnchorLocal(pin) {
      const axis = getPinLongitudinalAxis(pin);
      const sockets = (pin.userData?.holes || [])
        .map(socket => ({
          socket,
          position: new THREE.Vector3(socket.x, socket.y, socket.z)
        }))
        .filter(entry => Number.isFinite(entry.position.x) &&
          Number.isFinite(entry.position.y) && Number.isFinite(entry.position.z));
      if (sockets.length < 2) return new THREE.Vector3();

      sockets.sort((first, second) => first.position.dot(axis) - second.position.dot(axis));
      const firstEnd = sockets[0].position;
      const secondEnd = sockets[sockets.length - 1].position;
      return firstEnd.add(secondEnd).multiplyScalar(0.5);
    }

    function getPinSocketSide(pin, pinSocket) {
      const axis = getPinLongitudinalAxis(pin);
      const socketPosition = new THREE.Vector3(pinSocket.x, pinSocket.y, pinSocket.z);
      return Math.sign(socketPosition.sub(getPinInsertionAnchorLocal(pin)).dot(axis)) || 1;
    }

    function getWorldPinAxis(pin) {
      pin.updateMatrixWorld(true);
      return getPinLongitudinalAxis(pin)
        .applyQuaternion(pin.getWorldQuaternion(new THREE.Quaternion()))
        .normalize();
    }

    function getPartLongitudinalAxis(part) {
      const socketPositions = (part.userData?.holes || [])
        .map(socket => new THREE.Vector3(Number(socket.x), Number(socket.y), Number(socket.z)))
        .filter(position => Number.isFinite(position.x) &&
          Number.isFinite(position.y) && Number.isFinite(position.z));
      if (socketPositions.length < 2) return null;

      const center = socketPositions.reduce((sum, position) => sum.add(position), new THREE.Vector3())
        .multiplyScalar(1 / socketPositions.length);
      let initialAxis = null;
      let greatestDistanceSquared = 0;
      for (let firstIndex = 0; firstIndex < socketPositions.length - 1; firstIndex++) {
        for (let secondIndex = firstIndex + 1; secondIndex < socketPositions.length; secondIndex++) {
          const distanceSquared = socketPositions[firstIndex].distanceToSquared(socketPositions[secondIndex]);
          if (distanceSquared > greatestDistanceSquared) {
            greatestDistanceSquared = distanceSquared;
            initialAxis = socketPositions[secondIndex].clone().sub(socketPositions[firstIndex]);
          }
        }
      }
      if (!initialAxis || greatestDistanceSquared < Math.pow(GRID_CELL_SIZE * 0.75, 2)) return null;

      const covariance = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      socketPositions.forEach(position => {
        const offset = position.clone().sub(center);
        const values = [offset.x, offset.y, offset.z];
        for (let row = 0; row < 3; row++) {
          for (let column = 0; column < 3; column++) {
            covariance[row * 3 + column] += values[row] * values[column];
          }
        }
      });

      const axis = initialAxis.normalize();
      for (let iteration = 0; iteration < 12; iteration++) {
        const nextAxis = new THREE.Vector3(
          covariance[0] * axis.x + covariance[1] * axis.y + covariance[2] * axis.z,
          covariance[3] * axis.x + covariance[4] * axis.y + covariance[5] * axis.z,
          covariance[6] * axis.x + covariance[7] * axis.y + covariance[8] * axis.z
        );
        if (nextAxis.lengthSq() < 1e-10) return null;
        axis.copy(nextAxis.normalize());
      }

      let totalVariance = 0;
      let longitudinalVariance = 0;
      let minProjection = Infinity;
      let maxProjection = -Infinity;
      socketPositions.forEach(position => {
        const offset = position.clone().sub(center);
        const projection = offset.dot(axis);
        totalVariance += offset.lengthSq();
        longitudinalVariance += projection * projection;
        minProjection = Math.min(minProjection, projection);
        maxProjection = Math.max(maxProjection, projection);
      });
      if (maxProjection - minProjection < GRID_CELL_SIZE * 0.75 ||
        totalVariance <= 1e-10 || longitudinalVariance / totalVariance < 0.72) return null;
      return axis;
    }

    function alignPartAxisWithReference(part, referencePart, desiredQuaternion, worldNormal) {
      const partAxis = getPartLongitudinalAxis(part);
      const referenceAxis = getPartLongitudinalAxis(referencePart);
      if (!partAxis || !referenceAxis) return desiredQuaternion;

      const movingDirection = partAxis.applyQuaternion(desiredQuaternion)
        .projectOnPlane(worldNormal)
        .normalize();
      const referenceDirection = referenceAxis
        .applyQuaternion(referencePart.getWorldQuaternion(new THREE.Quaternion()))
        .projectOnPlane(worldNormal)
        .normalize();
      if (movingDirection.lengthSq() < 0.9 || referenceDirection.lengthSq() < 0.9) return desiredQuaternion;

      // A perforated straight beam has no preferred end, so keep the closest
      // direction and rotate only around the pin axis to line the two beams up.
      if (movingDirection.dot(referenceDirection) < 0) referenceDirection.negate();
      const rollAlignment = new THREE.Quaternion().setFromUnitVectors(movingDirection, referenceDirection);
      return rollAlignment.multiply(desiredQuaternion).normalize();
    }

    function straightenPinConnectedParts(pin) {
      const participants = [...getPinParticipants(pin)];
      if (participants.length !== 2) return false;

      const [referencePart, movingPart] = participants;
      const referenceJoint = joints.find(joint => joint.pin === pin &&
        (joint.partA === referencePart || joint.partB === referencePart));
      const movingJoint = joints.find(joint => joint.pin === pin &&
        (joint.partA === movingPart || joint.partB === movingPart));
      if (!referenceJoint || !movingJoint) return false;

      const referenceSocket = referenceJoint.partA === referencePart
        ? referenceJoint.socketA
        : referenceJoint.socketB;
      const movingSocket = movingJoint.partA === movingPart
        ? movingJoint.socketA
        : movingJoint.socketB;
      if (!referenceSocket || !movingSocket ||
        !getPartLongitudinalAxis(referencePart) || !getPartLongitudinalAxis(movingPart)) return false;

      const desiredQuaternion = alignPartAxisWithReference(
        movingPart,
        referencePart,
        movingPart.getWorldQuaternion(new THREE.Quaternion()),
        getWorldPinAxis(pin)
      );
      const referenceHoleWorld = getWorldSocketPosition(referencePart, referenceSocket);
      const movingHoleOffset = new THREE.Vector3(movingSocket.x, movingSocket.y, movingSocket.z)
        .applyQuaternion(desiredQuaternion);
      movePartToDesiredWorld(movingPart, referenceHoleWorld.sub(movingHoleOffset), desiredQuaternion);
      return true;
    }

    function getPinHingePoint(pin, movingPart) {
      const isInMovingPart = candidate => {
        let node = candidate;
        while (node) {
          if (node === movingPart) return true;
          node = node.parent;
        }
        return false;
      };
      const pinJoints = joints.filter(joint => joint.id.startsWith('magnetic_joint_') && joint.pin === pin);
      const fixedSideJoint = pinJoints.find(joint => {
        const connectedPart = joint.partA === pin ? joint.partB : joint.partA;
        return connectedPart && !isInMovingPart(connectedPart);
      }) || pinJoints[0];
      if (fixedSideJoint) {
        const fixedPart = fixedSideJoint.partA === pin ? fixedSideJoint.partB : fixedSideJoint.partA;
        const fixedSocket = fixedSideJoint.partA === pin ? fixedSideJoint.socketB : fixedSideJoint.socketA;
        if (fixedPart && fixedSocket) return getWorldSocketPosition(fixedPart, fixedSocket);
      }
      pin.updateMatrixWorld(true);
      return pin.getWorldPosition(new THREE.Vector3());
    }

    function getSocketLocalNormal(socket) {
      const normal = socket.normal;
      const isHorizontal = isHorizontalSocket(socket);
      const localNormal = Array.isArray(normal)
        ? new THREE.Vector3(...normal)
        : normal && typeof normal === 'object'
          ? new THREE.Vector3(normal.x, normal.y, normal.z)
          : isHorizontal
            ? new THREE.Vector3(0, 0, 1)
            : new THREE.Vector3(0, socket.y < 0 ? -1 : 1, 0);
      if (!isHorizontal && socket.y < 0 && Math.abs(localNormal.y) > 0.999) localNormal.y = -Math.abs(localNormal.y);
      return localNormal.normalize();
    }

    function getSocketDirection(socket) {
      const directions = [socket?.dir, socket?.type, socket?.orientation]
        .map(direction => String(direction || '').toLowerCase());
      if (directions.some(direction => ['horizontal', 'h', 'side'].includes(direction))) return 'horizontal';
      if (directions.some(direction => ['vertical', 'v', 'top', 'bottom'].includes(direction))) return 'vertical';

      const normal = socket?.normal;
      const normalY = Array.isArray(normal) ? Number(normal[1]) : Number(normal?.y);
      return Number.isFinite(normalY) && Math.abs(normalY) < 0.7 ? 'horizontal' : 'vertical';
    }

    function isHorizontalSocket(socket) {
      return getSocketDirection(socket) === 'horizontal';
    }

    function isVerticalSocket(socket) {
      return getSocketDirection(socket) === 'vertical';
    }

    function getSocketRaycastMeshes(part) {
      if (socketRaycastMeshesCache.has(part)) return socketRaycastMeshesCache.get(part);

      const meshes = [];
      part.traverse(child => {
        if (!child.isMesh || !child.geometry || child.userData?.isBadge ||
          child.userData?.isSocketNode || /^(?:SOCKET_HOLE_|socket_|hole_)/i.test(child.name || '')) return;

        let ancestor = child;
        while (ancestor && ancestor !== part) {
          if (!ancestor.visible || ancestor.name === 'badges' || ancestor.userData?.isBadge) return;
          ancestor = ancestor.parent;
        }
        if (ancestor === part) meshes.push(child);
      });

      socketRaycastMeshesCache.set(part, meshes);
      return meshes;
    }

    function hasSocketInsertionClearance(part, surfacePoint, inwardDirection) {
      const meshes = getSocketRaycastMeshes(part);
      if (!meshes.length) return false;

      part.updateMatrixWorld(true);
      const inward = inwardDirection.clone().normalize();
      if (inward.lengthSq() < 0.9) return false;

      const tangent = Math.abs(inward.y) < 0.9
        ? new THREE.Vector3(0, 1, 0).cross(inward).normalize()
        : new THREE.Vector3(1, 0, 0).cross(inward).normalize();
      const bitangent = inward.clone().cross(tangent).normalize();
      const probeOffsets = [new THREE.Vector3()];
      const sampleCount = 8;
      for (let index = 0; index < sampleCount; index++) {
        const angle = (index / sampleCount) * Math.PI * 2;
        probeOffsets.push(tangent.clone().multiplyScalar(Math.cos(angle) * SOCKET_ENTRY_PROBE_RADIUS)
          .addScaledVector(bitangent, Math.sin(angle) * SOCKET_ENTRY_PROBE_RADIUS));
      }

      const raycaster = new THREE.Raycaster();
      raycaster.near = 0;
      raycaster.far = MIN_SOCKET_INSERTION_DEPTH;
      const rayOrigin = new THREE.Vector3();
      // Require clearance for the pin shaft, not just its center point. This
      // rejects helper-node sockets placed over a solid face of an imported model.
      for (const offset of probeOffsets) {
        rayOrigin.copy(surfacePoint).add(offset).addScaledVector(inward, -SOCKET_RAY_START_OFFSET);
        raycaster.set(rayOrigin, inward);
        if (raycaster.intersectObjects(meshes, false).length) return false;
      }

      return true;
    }

    function getPinSnapQuaternion(pin, targetPart, targetSocket, pinSocket) {
      const currentQuaternion = pin.getWorldQuaternion(new THREE.Quaternion());
      const targetQuaternion = targetPart.getWorldQuaternion(new THREE.Quaternion());
      const currentWorldAxis = getPinLongitudinalAxis(pin)
        .applyQuaternion(currentQuaternion)
        .normalize();
      const targetWorldNormal = getSocketLocalNormal(targetSocket)
        .applyQuaternion(targetQuaternion)
        .normalize();

      if (currentWorldAxis.dot(targetWorldNormal) < 0) targetWorldNormal.negate();
      const alignment = new THREE.Quaternion().setFromUnitVectors(currentWorldAxis, targetWorldNormal);
      let desiredQuat = alignment.multiply(currentQuaternion);

      const localX = new THREE.Vector3(1, 0, 0).applyQuaternion(desiredQuat).normalize();
      let secondaryWorld = localX;
      if (Math.abs(secondaryWorld.dot(targetWorldNormal)) > 0.9) {
        secondaryWorld = new THREE.Vector3(0, 1, 0).applyQuaternion(desiredQuat).normalize();
      }

      const gridAxes = [
        new THREE.Vector3(1, 0, 0).applyQuaternion(targetQuaternion),
        new THREE.Vector3(0, 1, 0).applyQuaternion(targetQuaternion),
        new THREE.Vector3(0, 0, 1).applyQuaternion(targetQuaternion)
      ];

      let bestGridAxis = gridAxes[0];
      let maxDot = -Infinity;
      for (const axis of gridAxes) {
        const dot = secondaryWorld.dot(axis);
        if (Math.abs(dot) > maxDot) {
          maxDot = Math.abs(dot);
          bestGridAxis = axis.clone().multiplyScalar(Math.sign(dot));
        }
      }

      const projComp = secondaryWorld.projectOnPlane(targetWorldNormal).normalize();
      const projGrid = bestGridAxis.projectOnPlane(targetWorldNormal).normalize();

      if (projComp.lengthSq() > 0.1 && projGrid.lengthSq() > 0.1) {
        const rollAlign = new THREE.Quaternion().setFromUnitVectors(projComp, projGrid);
        desiredQuat.premultiply(rollAlign);
      }

      return desiredQuat;
    }

    function getPinSnapPosition(pin, snap, desiredQuaternion) {
      snap.targetPart.updateMatrixWorld(true);
      const targetSurface = new THREE.Vector3(
        snap.targetSocket.x,
        snap.targetSocket.y,
        snap.targetSocket.z
      ).applyMatrix4(snap.targetPart.matrixWorld);
      const collarOffset = getPinInsertionAnchorLocal(pin)
        .applyQuaternion(desiredQuaternion);
      return targetSurface.sub(collarOffset);
    }

    function correctPinJointSocketEnds(pin) {
      const localAxis = getPinLongitudinalAxis(pin);
      const worldAxis = localAxis.clone()
        .applyQuaternion(pin.getWorldQuaternion(new THREE.Quaternion()))
        .normalize();
      const pinJoints = joints.filter(joint => joint.id.startsWith('magnetic_joint_') &&
        (joint.partA === pin || joint.partB === pin));

      pinJoints.forEach(joint => {
        const targetPart = joint.partA === pin ? joint.partB : joint.partA;
        const targetSocket = joint.partA === pin ? joint.socketB : joint.socketA;
        if (!targetPart || !targetSocket) return;

        const targetNormal = getSocketLocalNormal(targetSocket)
          .applyQuaternion(targetPart.getWorldQuaternion(new THREE.Quaternion()))
          .normalize();
        const requiredSide = -(Math.sign(worldAxis.dot(targetNormal)) || 1);
        const expectedSocket = (pin.userData.holes || []).find(socket => {
          const side = Math.sign(new THREE.Vector3(socket.x, socket.y, socket.z).dot(localAxis)) || 1;
          return side === requiredSide;
        });
        if (!expectedSocket) return;

        const expectedSocketInUse = pinJoints.some(other => other !== joint &&
          ((other.partA === pin && socketsMatch(other.socketA, expectedSocket)) ||
            (other.partB === pin && socketsMatch(other.socketB, expectedSocket))));
        if (expectedSocketInUse) return;

        if (joint.partA === pin) joint.socketA = expectedSocket;
        else joint.socketB = expectedSocket;
      });
    }

    function getMagneticPartners(part) {
      const partners = [];
      joints.forEach(j => {
        if (!j.id.startsWith('magnetic_joint_')) return;
        if (j.partA === part && j.partB && !partners.includes(j.partB)) partners.push(j.partB);
        if (j.partB === part && j.partA && !partners.includes(j.partA)) partners.push(j.partA);
      });
      return partners;
    }

    function canMagneticallyReattach(part, targetPart) {
      const releaseParts = part.userData.magneticReleaseParts || [];
      if (!releaseParts.includes(targetPart)) return true;

      const origin = part.userData.magneticReleaseOrigin;
      const current = part.getWorldPosition(new THREE.Vector3());
      if (!origin || current.distanceTo(origin) > 0.65) {
        part.userData.magneticReleaseParts = [];
        part.userData.magneticReleaseOrigin = null;
        return true;
      }
      return false;
    }

    function getPreferredPinSnapSide(pin, pinSocket, targetPart, targetSocket) {
      pin.updateMatrixWorld(true);
      targetPart.updateMatrixWorld(true);
      const targetQuaternion = targetPart.getWorldQuaternion(new THREE.Quaternion());
      const targetNormal = getSocketLocalNormal(targetSocket)
        .applyQuaternion(targetQuaternion)
        .normalize();
      const holeCenter = new THREE.Vector3(targetSocket.x, 0, targetSocket.z)
        .applyMatrix4(targetPart.matrixWorld);
      const pinCenter = pin.getWorldPosition(new THREE.Vector3());
      const signedDistance = pinCenter.sub(holeCenter).dot(targetNormal);

      // Keep using the face the pin is approaching; only fall back to its
      // current axis when it is nearly centered on the hole plane.
      if (Math.abs(signedDistance) > 0.05) return Math.sign(signedDistance);

      const pinAxis = getPinLongitudinalAxis(pin);
      const pinSocketSide = getPinSocketSide(pin, pinSocket);
      const currentWorldAxis = pinAxis.multiplyScalar(pinSocketSide)
        .applyQuaternion(pin.getWorldQuaternion(new THREE.Quaternion()))
        .normalize();
      return -(Math.sign(currentWorldAxis.dot(targetNormal)) || -1);
    }

    function findNearestPinSnap(pin, maxDistance = 1.0, _activeSocket = null, excludedTargetParts = null) {
      // Keep existing pin joints intact and only snap with an unused end.
      const pinSockets = (pin.userData.holes || [])
        .filter(pinSocket => !isMagneticSocketOccupied(pin, pinSocket));

      let nearest = null;
      pin.updateMatrixWorld(true);

      for (const pinSocket of pinSockets) {
        for (const targetPart of parts) {
          if (targetPart === pin || isMagneticPinPart(targetPart)) continue;
          if (excludedTargetParts?.has(targetPart)) continue;
          if (!canMagneticallyReattach(pin, targetPart)) continue;
          if (isMagneticSocketOccupied(pin, pinSocket)) continue;

          for (const targetSocket of targetPart.userData?.holes || []) {
            if (isMagneticSocketOccupied(targetPart, targetSocket)) continue;
            if (!PinManager.canSnapShape(pinSocket.shape, targetSocket.shape)) continue;

            // ==============================================================
            // 🌟 CHÌA KHÓA UX: LỖ XUYÊN THẤU CÓ THỂ CẮM TỪ 2 MẶT (+1 VÀ -1)
            // ==============================================================
            const sidesToCheck = isVerticalSocket(targetSocket)
              ? [getPreferredPinSnapSide(pin, pinSocket, targetPart, targetSocket)]
              : [1];

            for (const sideMultiplier of sidesToCheck) {
                targetPart.updateMatrixWorld(true);
                
                // 1. Tính bề mặt tiếp xúc của lỗ (Mặt trước hoặc Mặt sau)
                const surfaceY = targetSocket.y * sideMultiplier;
                const targetSurfacePos = new THREE.Vector3(targetSocket.x, surfaceY, targetSocket.z).applyMatrix4(targetPart.matrixWorld);

                // 2. Tính khoảng cách từ Vành cữ chốt (y=0) tới mặt lỗ đang xét
                const pinAnchorLocal = getPinInsertionAnchorLocal(pin);
                const pinCollarPosition = pinAnchorLocal.clone().applyMatrix4(pin.matrixWorld);
                const distance = pinCollarPosition.distanceTo(targetSurfacePos);

                const snapDistance = Math.min(maxDistance, MAX_MAGNETIC_SNAP_DISTANCE);
                if (distance > snapDistance) continue;

                // 3. Tính Quaternion (Hướng đâm)
                const currentQuaternion = pin.getWorldQuaternion(new THREE.Quaternion());
                const targetQuaternion = targetPart.getWorldQuaternion(new THREE.Quaternion());

                // Tính hướng của trục chốt
                const pinAxis = getPinLongitudinalAxis(pin);
                const pinSocketSide = getPinSocketSide(pin, pinSocket);
                const currentWorldAxis = pinAxis.clone().multiplyScalar(pinSocketSide).applyQuaternion(currentQuaternion).normalize();

                // Tính pháp tuyến của mặt lỗ đang xét (đã đảo chiều nếu là mặt sau)
                const localNormal = getSocketLocalNormal(targetSocket).multiplyScalar(sideMultiplier);
                const targetWorldNormal = localNormal.applyQuaternion(targetQuaternion).normalize();

                // Nguyên tắc vật lý: Hướng của chốt phải NGƯỢC LẠI với pháp tuyến lỗ để đâm sâu vào trong
                const desiredWorldNormal = targetWorldNormal.clone().negate();
                if (!hasSocketInsertionClearance(targetPart, targetSurfacePos, desiredWorldNormal)) continue;

                const alignment = new THREE.Quaternion().setFromUnitVectors(currentWorldAxis, desiredWorldNormal);
                let desiredWorldQuaternion = alignment.multiply(currentQuaternion);

                // ==========================================
                // KHÓA GÓC XOAY 90 ĐỘ (ROLL LOCK) CHỐNG LẬT
                // ==========================================
                const localX = new THREE.Vector3(1, 0, 0).applyQuaternion(desiredWorldQuaternion).normalize();
                let secondaryWorld = localX;
                if (Math.abs(secondaryWorld.dot(desiredWorldNormal)) > 0.9) {
                    secondaryWorld = new THREE.Vector3(0, 1, 0).applyQuaternion(desiredWorldQuaternion).normalize();
                }

                const gridAxes = [
                    new THREE.Vector3(1, 0, 0).applyQuaternion(targetQuaternion),
                    new THREE.Vector3(0, 1, 0).applyQuaternion(targetQuaternion),
                    new THREE.Vector3(0, 0, 1).applyQuaternion(targetQuaternion)
                ];

                let bestGridAxis = gridAxes[0];
                let maxDot = -Infinity;
                for (const axis of gridAxes) {
                    const dot = secondaryWorld.dot(axis);
                    if (Math.abs(dot) > maxDot) {
                        maxDot = Math.abs(dot);
                        bestGridAxis = axis.clone().multiplyScalar(Math.sign(dot));
                    }
                }

                const projComp = secondaryWorld.projectOnPlane(desiredWorldNormal).normalize();
                const projGrid = bestGridAxis.projectOnPlane(desiredWorldNormal).normalize();

                if (projComp.lengthSq() > 0.1 && projGrid.lengthSq() > 0.1) {
                    const rollAlign = new THREE.Quaternion().setFromUnitVectors(projComp, projGrid);
                    desiredWorldQuaternion.premultiply(rollAlign);
                }
                // ==========================================

                // The two end sockets on a pin share the same collar position.
                // Break equal-distance ties by the smallest rotation so moving
                // a pin does not silently exchange its top and bottom ends.
                const orientationChange = currentQuaternion.angleTo(desiredWorldQuaternion);
                if (nearest && (distance > nearest.distance + 1e-6 ||
                  (Math.abs(distance - nearest.distance) <= 1e-6 &&
                    orientationChange >= nearest.orientationChange))) continue;

                // 4. Tính Vị trí tịnh tiến cuối cùng
                const rotatedCollarOffset = pinAnchorLocal.applyQuaternion(desiredWorldQuaternion);
                const desiredWorldPosition = targetSurfacePos.clone().sub(rotatedCollarOffset);

                // Kiểm tra va chạm với mặt đất
                if (wouldPartTransformGoBelowGround(pin, desiredWorldPosition, desiredWorldQuaternion)) continue;

                nearest = {
                  pinSocket,
                  targetPart,
                  targetSocket,
                  targetPosition: targetSurfacePos,
                  desiredWorldPosition,
                  desiredWorldQuaternion,
                  orientationChange,
                  distance
                };
            }
          }
        }
      }

      return nearest;
    }

    function findNearestComponentSnap(part, maxDistance = 1.0, excludedPins = null, activeSocket = null) {
      const componentSockets = [...(part.userData.holes || [])];
      if (activeSocket) {
        componentSockets.sort((first, second) =>
          Number(socketsMatch(second, activeSocket)) - Number(socketsMatch(first, activeSocket))
        );
      }

      let nearest = null;

      for (const componentSocket of componentSockets) {
        for (const pin of parts) {
          if (!isMagneticPinPart(pin) || pin === part || excludedPins?.has(pin)) continue;
          if (!canMagneticallyReattach(part, pin)) continue;
          pin.updateMatrixWorld(true);
          correctPinJointSocketEnds(pin);

          for (const pinSocket of pin.userData.holes || []) {
            if (isMagneticSocketOccupied(pin, pinSocket, part)) continue;
            if (isMagneticSocketOccupied(part, componentSocket, pin)) continue;
            if (!PinManager.canSnapShape(pinSocket.shape, componentSocket.shape)) continue;
            
            const verticalSocket = isVerticalSocket(componentSocket);
            const pinAxis = getPinLongitudinalAxis(pin);
            const pinSocketSide = getPinSocketSide(pin, pinSocket);
            const surfaceY = verticalSocket
              ? (pinSocketSide > 0 ? -Math.abs(componentSocket.y) : Math.abs(componentSocket.y))
              : componentSocket.y;
            const localSurfacePoint = new THREE.Vector3(componentSocket.x, surfaceY, componentSocket.z);
            part.updateMatrixWorld(true);
            const holeWorldPos = localSurfacePoint.clone().applyMatrix4(part.matrixWorld);
            pin.updateMatrixWorld(true);
            const pinCollarLocal = getPinInsertionAnchorLocal(pin);
            const pinCollarWorldPos = pinCollarLocal.applyMatrix4(pin.matrixWorld);
            // Rank candidates from the same collar-to-surface anchors used below
            // to place the component; tip distance can select a neighboring hole.
            const distance = holeWorldPos.distanceTo(pinCollarWorldPos);
            
            const snapDistance = Math.min(maxDistance, MAX_MAGNETIC_SNAP_DISTANCE);
            if (distance > snapDistance || (nearest && distance >= nearest.distance)) continue;

            // 2. LOGIC QUATERNION (Primary Alignment - Gióng trục đâm)
            const currentQuaternion = part.getWorldQuaternion(new THREE.Quaternion());
            const compLocalNormal = getSocketLocalNormal(componentSocket);
            if (verticalSocket && surfaceY * componentSocket.y < 0) compLocalNormal.negate();
            const componentWorldNormal = compLocalNormal.clone().applyQuaternion(currentQuaternion).normalize();
            if (!hasSocketInsertionClearance(part, holeWorldPos, componentWorldNormal.clone().negate())) continue;

            const pinWorldAxis = pinAxis
              .clone()
              .applyQuaternion(pin.getWorldQuaternion(new THREE.Quaternion()))
              .normalize();

            const pinWorldNormal = pinWorldAxis.clone().multiplyScalar(pinSocketSide);
            const desiredWorldNormal = verticalSocket
              ? pinWorldAxis.clone().multiplyScalar(-pinSocketSide)
              : pinWorldNormal.clone();
            if (!verticalSocket && componentWorldNormal.dot(desiredWorldNormal) < 0) {
              desiredWorldNormal.negate();
            }
            
            const alignmentQuaternion = new THREE.Quaternion()
              .setFromUnitVectors(componentWorldNormal, desiredWorldNormal);
            let desiredWorldQuaternion = alignmentQuaternion.multiply(currentQuaternion);

            // ==========================================
            // TÍNH NĂNG MỚI: SNAP ROLL (Khóa góc chống lật)
            // ==========================================
            // A. Tìm một trục phụ của thanh dầm (vuông góc với hướng đâm)
            let localSecondary = new THREE.Vector3(1, 0, 0); 
            if (Math.abs(compLocalNormal.x) > 0.9) localSecondary.set(0, 1, 0); 
            const compSecondaryWorld = localSecondary.clone().applyQuaternion(desiredWorldQuaternion).normalize();
            
            // B. Lấy các trục của chốt làm hệ quy chiếu (Grid 90 độ)
            const pinQuat = pin.getWorldQuaternion(new THREE.Quaternion());
            const pinAxes = [
              new THREE.Vector3(1, 0, 0).applyQuaternion(pinQuat),
              new THREE.Vector3(0, 1, 0).applyQuaternion(pinQuat),
              new THREE.Vector3(0, 0, 1).applyQuaternion(pinQuat)
            ];
            
            // C. Tìm trục của chốt gần với hướng hiện tại của thanh dầm nhất
            let bestPinAxis = pinAxes[0];
            let maxDot = -Infinity;
            for (let axis of pinAxes) {
              let dot = compSecondaryWorld.dot(axis);
              if (Math.abs(dot) > maxDot) {
                maxDot = Math.abs(dot);
                bestPinAxis = axis.clone().multiplyScalar(Math.sign(dot) || 1);
              }
            }
            
            // D. Chiếu cả 2 trục lên mặt phẳng và xoay ép thanh dầm vào lưới
            const projComp = compSecondaryWorld.projectOnPlane(desiredWorldNormal).normalize();
            const projPin = bestPinAxis.projectOnPlane(desiredWorldNormal).normalize();
            
            if (projComp.lengthSq() > 0.1 && projPin.lengthSq() > 0.1) {
              const rollAlign = new THREE.Quaternion().setFromUnitVectors(projComp, projPin);
              desiredWorldQuaternion.premultiply(rollAlign); 
            }
            // ==========================================

            // When a pin already holds one straight, perforated part, use its
            // connected hole as the anchor for the incoming part's hole row.
            const referencePart = [...getPinParticipants(pin)].find(participant => participant !== part);
            let straighteningAnchor = null;
            if (referencePart) {
              const referenceJoint = joints.find(joint => joint.pin === pin &&
                (joint.partA === referencePart || joint.partB === referencePart));
              const referenceSocket = referenceJoint
                ? (referenceJoint.partA === referencePart ? referenceJoint.socketA : referenceJoint.socketB)
                : null;
              if (referenceSocket && getPartLongitudinalAxis(part) && getPartLongitudinalAxis(referencePart)) {
                const snapNormal = getSocketLocalNormal(componentSocket)
                  .applyQuaternion(desiredWorldQuaternion)
                  .normalize();
                desiredWorldQuaternion = alignPartAxisWithReference(
                  part,
                  referencePart,
                  desiredWorldQuaternion,
                  snapNormal
                );
                straighteningAnchor = { referencePart, referenceSocket, componentSocket };
              }
            }

            // 3. TÍNH VỊ TRÍ CHUẨN
            let desiredWorldPosition;
            if (straighteningAnchor) {
              // Put both selected hole centers on the same point as well as
              // aligning their hole rows; matching directions alone leaves
              // long beams parallel but visibly offset from one another.
              const referenceHoleWorld = getWorldSocketPosition(
                straighteningAnchor.referencePart,
                straighteningAnchor.referenceSocket
              );
              const componentHoleOffset = new THREE.Vector3(
                straighteningAnchor.componentSocket.x,
                straighteningAnchor.componentSocket.y,
                straighteningAnchor.componentSocket.z
              ).applyQuaternion(desiredWorldQuaternion);
              desiredWorldPosition = referenceHoleWorld.sub(componentHoleOffset);
            } else {
              const rotatedHoleOffset = localSurfacePoint.clone().applyQuaternion(desiredWorldQuaternion);
              desiredWorldPosition = pinCollarWorldPos.clone().sub(rotatedHoleOffset);
            }
            if (wouldPartTransformGoBelowGround(part, desiredWorldPosition, desiredWorldQuaternion)) continue;
            
            nearest = {
              componentSocket,
              pin,
              pinSocket,
              pinPosition: getWorldSocketPosition(pin, pinSocket),
              desiredWorldPosition,
              desiredWorldQuaternion,
              distance
            };
          }
        }
      }

      return nearest;
    }

    function isMagneticSocketOccupied(part, socket, exceptPart = null) {
      return joints.some(j => {
        if (!j.id.startsWith('magnetic_joint_')) return false;
        if (j.partA === exceptPart || j.partB === exceptPart) return false;
        return (j.partA === part && socketsMatch(j.socketA, socket)) ||
          (j.partB === part && socketsMatch(j.socketB, socket));
      });
    }

    function getPinJointConnecting(pin, part) {
      return joints.find(joint => joint.id.startsWith('magnetic_joint_') &&
        joint.pin === pin &&
        ((joint.partA === pin && joint.partB === part) ||
          (joint.partB === pin && joint.partA === part))) || null;
    }

    function socketsMatch(firstSocket, secondSocket) {
      if (firstSocket === secondSocket) return true;
      return Boolean(firstSocket && secondSocket &&
        Number(firstSocket.index) === Number(secondSocket.index) &&
        getSocketDirection(firstSocket) === getSocketDirection(secondSocket));
    }

    function getConnectedPinSocket(pin) {
      const joint = joints.find(j => j.id.startsWith('magnetic_joint_') &&
        j.pin === pin);
      if (!joint) return null;

      if (joint.partA === pin) return joint.socketA;
      if (joint.partB === pin) return joint.socketB;
      return null;
    }

    function detachMagneticJoints(part) {
      const detachedJoints = joints.filter(j => j.id.startsWith('magnetic_joint_') &&
        (j.partA === part || j.partB === part || j.pin === part));
      if (!detachedJoints.length) return;

      const affectedParts = new Set([part]);
      detachedJoints.forEach(joint => {
        [joint.partA, joint.partB, joint.pin, joint.kinematicParent, joint.kinematicChild]
          .filter(Boolean)
          .forEach(affectedPart => affectedParts.add(affectedPart));
      });
      const detachedSet = new Set(detachedJoints);
      joints = joints.filter(j => !detachedSet.has(j));
      syncMagneticStateForParts(affectedParts);
      updateJointsUI();
    }

    function detachMagneticSocket(part, socket) {
      const previousLength = joints.length;
      joints = joints.filter(j => {
        if (!j.id.startsWith('magnetic_joint_')) return true;
        const usesSocket = (j.partA === part && socketsMatch(j.socketA, socket)) ||
          (j.partB === part && socketsMatch(j.socketB, socket));
        return !usesSocket;
      });

      if (joints.length !== previousLength) updateJointsUI();
    }

    function detachPinJoints(pin) {
      detachMagneticJoints(pin);
    }

    // ==========================================
    // HỆ THỐNG QUẢN LÝ CỤM LẮP RÁP (ASSEMBLY)
    // ==========================================

    let rotationPivotGroup = null;
    let rotationPivotPart = null;
    let rotationPivotParents = new Map();

    function getConnectedPins(part) {
      return [...new Set(joints.map(joint => joint.pin)
        .filter(pin => isMagneticPinPart(pin) && getPinParticipants(pin).has(part)))];
    }

    function getPinParticipants(pin) {
      const participants = new Set();
      joints.forEach(joint => {
        if (joint.pin !== pin) return;
        [joint.partA, joint.partB].forEach(part => {
          if (part && part !== pin && !isMagneticPinPart(part)) participants.add(part);
        });
      });
      return participants;
    }

    function getPinEndpointConnections(pin, structuralPartSet) {
      const endpoints = new Map();
      let hasConflictingEndpoint = false;

      joints.forEach(joint => {
        if (joint.pin !== pin) return;

        let structuralPart = null;
        let pinSocket = null;
        if (joint.partA === pin) {
          structuralPart = joint.partB;
          pinSocket = joint.socketA;
        } else if (joint.partB === pin) {
          structuralPart = joint.partA;
          pinSocket = joint.socketB;
        }
        if (!structuralPart || !structuralPartSet.has(structuralPart)) return;

        const socketIndex = Number(pinSocket?.index);
        const hasSocketIndex = pinSocket?.index !== undefined && pinSocket?.index !== null &&
          Number.isFinite(socketIndex);
        const hasSocketPosition = pinSocket &&
          [pinSocket.x, pinSocket.y, pinSocket.z].every(value => Number.isFinite(Number(value)));
        const endpointKey = hasSocketIndex
          ? `${socketIndex}:${getSocketDirection(pinSocket)}`
          : hasSocketPosition
            ? `${pinSocket.x},${pinSocket.y},${pinSocket.z}:${getSocketDirection(pinSocket)}`
            : null;
        if (!endpointKey) return;

        const existingPart = endpoints.get(endpointKey);
        if (existingPart && existingPart !== structuralPart) {
          hasConflictingEndpoint = true;
          return;
        }
        endpoints.set(endpointKey, structuralPart);
      });

      return hasConflictingEndpoint
        ? []
        : [...endpoints].map(([endpointKey, part]) => ({ endpointKey, part }));
    }

    function repairSeatedPinConnections() {
      let changed = false;
      const affectedParts = new Set();
      const structuralParts = parts.filter(part => !isMagneticPinPart(part));

      parts.filter(isMagneticPinPart).forEach(pin => {
        const pinSockets = pin.userData?.holes || [];
        if (pinSockets.length < 2) return;

        pin.updateMatrixWorld(true);
        const insertionAnchor = getPinInsertionAnchorLocal(pin).applyMatrix4(pin.matrixWorld);
        const worldPinAxis = getWorldPinAxis(pin);
        const participants = getPinParticipants(pin);
        if (participants.size >= 2) return;

        for (const pinSocket of pinSockets) {
          if (isMagneticSocketOccupied(pin, pinSocket)) continue;
          let nearest = null;

          for (const targetPart of structuralParts) {
            if (targetPart === pin || participants.has(targetPart) ||
              !canMagneticallyReattach(pin, targetPart) ||
              !canMagneticallyReattach(targetPart, pin)) continue;
            targetPart.updateMatrixWorld(true);

            for (const targetSocket of targetPart.userData?.holes || []) {
              if (isMagneticSocketOccupied(targetPart, targetSocket) ||
                !PinManager.canSnapShape(pinSocket.shape, targetSocket.shape)) continue;

              const sideMultipliers = isVerticalSocket(targetSocket) ? [1, -1] : [1];
              for (const sideMultiplier of sideMultipliers) {
                const surfaceY = isVerticalSocket(targetSocket)
                  ? targetSocket.y * sideMultiplier
                  : targetSocket.y;
                const surfacePoint = new THREE.Vector3(targetSocket.x, surfaceY, targetSocket.z)
                  .applyMatrix4(targetPart.matrixWorld);
                const distance = insertionAnchor.distanceTo(surfacePoint);
                if (distance > SEATED_PIN_SOCKET_TOLERANCE ||
                  (nearest && distance >= nearest.distance)) continue;

                const targetNormal = getSocketLocalNormal(targetSocket)
                  .multiplyScalar(sideMultiplier)
                  .applyQuaternion(targetPart.getWorldQuaternion(new THREE.Quaternion()))
                  .normalize();
                const axisAlignment = worldPinAxis.dot(targetNormal);
                if (Math.abs(axisAlignment) < 0.98) continue;

                const expectedPinSide = -(Math.sign(axisAlignment) || 1);
                if (getPinSocketSide(pin, pinSocket) !== expectedPinSide) continue;
                if (!hasSocketInsertionClearance(targetPart, surfacePoint, targetNormal.clone().negate())) continue;

                nearest = { targetPart, targetSocket, distance };
              }
            }
          }

          if (!nearest || participants.size >= 2) continue;
          const pinHasSupport = participants.size > 0;
          const jointId = createMagneticJointId();
          joints.push({
            id: jointId,
            partA: pin,
            partB: nearest.targetPart,
            socketA: pinSocket,
            socketB: nearest.targetSocket,
            pin,
            kinematicParent: pinHasSupport ? pin : nearest.targetPart,
            kinematicChild: pinHasSupport ? nearest.targetPart : pin
          });
          pendingPinStraightening.add(pin);
          affectedParts.add(pin);
          affectedParts.add(nearest.targetPart);
          participants.add(nearest.targetPart);
          changed = true;
        }
      });

      if (changed) syncMagneticStateForParts(affectedParts);
      return changed;
    }

    function getPinPairStates() {
      const structuralParts = parts.filter(part => !isMagneticPinPart(part));
      const structuralPartSet = new Set(structuralParts);
      const pairStates = new Map(structuralParts.map(part => [part, new Map()]));
      const pins = [...new Set(joints.map(joint => joint.pin).filter(isMagneticPinPart))];

      pins.forEach(pin => {
        const endpoints = getPinEndpointConnections(pin, structuralPartSet);
        const participants = [...getPinParticipants(pin)]
          .filter(part => structuralPartSet.has(part));

        if (participants.length !== 2 || participants[0] === participants[1]) return;
        if (endpoints.length === 2) {
          const endpointParticipants = new Set(endpoints.map(endpoint => endpoint.part));
          if (endpointParticipants.size !== 2 ||
            participants.some(part => !endpointParticipants.has(part))) return;
        }

        const [first, second] = participants;
        let state = pairStates.get(first).get(second);
        if (!state) {
          state = { parts: [first, second], pins: new Set() };
          pairStates.get(first).set(second, state);
          pairStates.get(second).set(first, state);
        }
        state.pins.add(pin);
      });

      pairStates.forEach(partners => partners.forEach(state => {
        state.pinCount = state.pins.size;
        state.type = state.pinCount >= 2 ? 'rigid' : 'hinge';
      }));
      return pairStates;
    }

    function isPartLockedByMultiplePins(part, pairStates = getPinPairStates()) {
      const relatedStructuralParts = isMagneticPinPart(part)
        ? [...getPinParticipants(part)]
        : [part];
      return relatedStructuralParts.some(structuralPart =>
        [...(pairStates.get(structuralPart)?.values() || [])]
          .some(state => state.type === 'rigid'));
    }

    function getHingePinForPart(part, pairStates = getPinPairStates()) {
      const partnerStates = [...(pairStates.get(part)?.values() || [])];
      const hingeState = partnerStates.find(state => state.type === 'hinge');
      return hingeState ? [...hingeState.pins][0] : null;
    }

    function restoreRotationPivot() {
      if (!rotationPivotGroup) return;

      [...rotationPivotParents.entries()].reverse().forEach(([member, originalParent]) => {
        if (originalParent?.parent) originalParent.attach(member);
        else scene.attach(member);
      });
      rotationPivotGroup.parent?.remove(rotationPivotGroup);
      rotationPivotGroup = null;
      rotationPivotPart = null;
      rotationPivotParents.clear();
    }

    function createRotationPivot(part, mode = toolMode) {
      if (rotationPivotGroup && rotationPivotPart === part) return rotationPivotGroup;
      restoreRotationPivot();

      const pairStates = getPinPairStates();
      const rigidTwoPinLock = mode === 'rotate' && !isMagneticPinPart(part) &&
        isPartLockedByMultiplePins(part, pairStates);
      if (rigidTwoPinLock && !(part.parent?.userData?.isAssemblyGroup &&
        !part.parent.userData.isRotationPivotGroup)) {
        reconcileRigidAssemblies({ refreshTransformControls: false });
      }

      const getNode = object => object?.parent?.userData.isAssemblyGroup &&
        !object.parent.userData.isRotationPivotGroup ? object.parent : object;
      const adjacency = new Map();
      const connected = new Map();
      const incomingPivotPins = new Map();
      const connect = (parent, child) => {
        if (!parent || !child || parent === child) return;
        if (!adjacency.has(parent)) adjacency.set(parent, new Set());
        adjacency.get(parent).add(child);
        if (!connected.has(parent)) connected.set(parent, new Set());
        if (!connected.has(child)) connected.set(child, new Set());
        connected.get(parent).add(child);
        connected.get(child).add(parent);
      };

      joints.forEach(joint => {
        const pin = getNode(joint.pin);
        const explicitParent = joint.kinematicParent;
        const explicitChild = joint.kinematicChild;
        if (explicitParent && explicitChild) {
          const parent = getNode(explicitParent);
          const child = getNode(explicitChild);
          if (joint.pin && joint.pin !== explicitParent && joint.pin !== explicitChild) {
            connect(parent, pin);
            connect(pin, child);
            incomingPivotPins.set(child, joint.pin);
          } else {
            connect(parent, child);
            if (joint.pin === explicitParent) incomingPivotPins.set(child, joint.pin);
          }
          return;
        }

        const first = getNode(joint.partA);
        const second = getNode(joint.partB);
        if (!pin) {
          connect(first, second);
        } else if (joint.pin === joint.partA) {
          if (joint.pin.userData?.magneticJointId === joint.id) connect(second, pin);
          else if (joint.pin.userData?.magneticJointId) {
            connect(pin, second);
            incomingPivotPins.set(second, joint.pin);
          } else connect(second, pin);
        } else if (joint.pin === joint.partB) {
          if (joint.pin.userData?.magneticJointId === joint.id) connect(first, pin);
          else if (joint.pin.userData?.magneticJointId) {
            connect(pin, first);
            incomingPivotPins.set(first, joint.pin);
          } else connect(first, pin);
        } else {
          connect(first, pin);
          connect(pin, second);
          incomingPivotPins.set(second, joint.pin);
        }
      });

      const rootNode = getNode(part);
      const hingePin = mode === 'rotate' && !isMagneticPinPart(part) && !rigidTwoPinLock
        ? incomingPivotPins.get(rootNode) || getHingePinForPart(part, pairStates) || getConnectedPins(part)[0] || null
        : null;
      // A single pin is a hinge: rotate only the selected structural part
      // around that pin, regardless of which part was connected first. If the
      // part belongs to a rigid assembly, rootNode is the whole assembly group.
      // Dragging and rotating a pin continue to move their connected branch.
      let traversal = connected;
      if (mode === 'rotate' && !isMagneticPinPart(part)) {
        // A two-pin connection moves as one rigid assembly. With one pin,
        // keep the attached connector with the moving structural part.
        const movingPinNodes = rigidTwoPinLock ? [] : getConnectedPins(part)
          .map(getNode)
          .filter(node => node && node !== rootNode);
        traversal = new Map([[rootNode, new Set(movingPinNodes)]]);
      }
      const pending = [rootNode];
      const visited = new Set();
      const parentNodes = new Map();
      while (pending.length) {
        const current = pending.shift();
        if (!current || visited.has(current)) continue;
        visited.add(current);
        for (const child of traversal.get(current) || []) {
          if (visited.has(child)) continue;
          parentNodes.set(child, current);
          pending.push(child);
        }
      }
      if (visited.size < 2 && !hingePin && !rigidTwoPinLock) return null;

      scene.updateMatrixWorld(true);
      const pivotPosition = rigidTwoPinLock
        ? new THREE.Box3().setFromObject(rootNode).getCenter(new THREE.Vector3())
        : hingePin
          ? getPinHingePoint(hingePin, part)
          : part.getWorldPosition(new THREE.Vector3());
      const pivotGroup = new THREE.Group();
      pivotGroup.userData.isAssemblyGroup = true;
      pivotGroup.userData.isRotationPivotGroup = true;
      pivotGroup.userData.isRigidTwoPinPivot = rigidTwoPinLock;
      pivotGroup.position.copy(pivotPosition);
      if (hingePin) {
        pivotGroup.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          getWorldPinAxis(hingePin)
        );
        pivotGroup.userData.hingePinId = hingePin.userData?.id || null;
      }
      scene.add(pivotGroup);

      rotationPivotParents = new Map([...visited].map(node => [node, node.parent]));
      rotationPivotGroup = pivotGroup;
      rotationPivotPart = part;
      pivotGroup.attach(rootNode);
      parentNodes.forEach((parent, child) => parent.attach(child));
      return pivotGroup;
    }

    function canRotateWholeRigidCluster(part, transformTarget) {
      if (!part || !transformTarget) return false;
      if (isPartLockedByMultiplePins(part)) return false;
      const assemblyGroup = part.parent?.userData?.isAssemblyGroup &&
        !part.parent.userData.isRotationPivotGroup
        ? part.parent
        : null;
      if (!assemblyGroup) return true;
      return transformTarget === assemblyGroup || Boolean(
        transformTarget.userData?.isRotationPivotGroup && rotationPivotParents.has(assemblyGroup)
      );
    }

    function getTransformTargetForPart(part, mode = toolMode) {
      const pivotGroup = mode === 'rotate' || mode === 'translate' ? createRotationPivot(part, mode) : null;
      return pivotGroup || (part.parent?.userData.isAssemblyGroup ? part.parent : part);
    }

    function lockIntoAssembly() {
      reconcileRigidAssemblies();
    }

    function reconcileRigidAssemblies({ refreshTransformControls = true } = {}) {
      restoreRotationPivot();
      const repairedSeatedPins = repairSeatedPinConnections();
      const { structuralParts } = updateRigidClusters();
      const oldGroups = new Set(parts
        .map(part => part.parent)
        .filter(parent => parent?.userData.isAssemblyGroup && !parent.userData.isRotationPivotGroup));
      oldGroups.forEach(group => {
        [...group.children].forEach(child => scene.attach(child));
        group.parent?.remove(group);
      });

      const pinsToStraighten = [...pendingPinStraightening];
      pendingPinStraightening.clear();
      pinsToStraighten.forEach(straightenPinConnectedParts);

      const partsByCluster = new Map();
      structuralParts.forEach(part => {
        if (!partsByCluster.has(part.userData.clusterId)) partsByCluster.set(part.userData.clusterId, []);
        partsByCluster.get(part.userData.clusterId).push(part);
      });

      const allPins = [...new Set(joints.map(joint => joint.pin).filter(isMagneticPinPart))];
      partsByCluster.forEach((clusterParts, clusterId) => {
        if (clusterParts.length < 2) return;
        const clusterPartSet = new Set(clusterParts);
        const clusterPins = allPins.filter(pin => {
          const participants = getPinParticipants(pin);
          return participants.size > 0 && [...participants].every(part => clusterPartSet.has(part));
        });

        const assemblyGroup = new THREE.Group();
        assemblyGroup.userData.isAssemblyGroup = true;
        assemblyGroup.userData.clusterId = clusterId;
        scene.add(assemblyGroup);
        [...clusterParts, ...clusterPins].forEach(member => assemblyGroup.attach(member));
      });

      if (toolMode === 'rotate' && selectedPart && isPartLockedByMultiplePins(selectedPart)) {
        showToast('Cặp thanh đã khóa xoay bởi 2 chốt', 'error');
        setToolMode('select');
      }

      if (refreshTransformControls && selectedPart && parts.includes(selectedPart) &&
        toolMode !== 'select' && transformControls) {
        const target = getTransformTargetForPart(selectedPart, toolMode);
        transformControls.attach(target);
        transformControls.setMode(toolMode === 'rotate' ? 'rotate' : 'translate');
        transformControls.setSpace(
          toolMode === 'rotate' && target.userData?.hingePinId ? 'local' : 'world'
        );
      }
      if (repairedSeatedPins && typeof updateJointsUI === 'function') updateJointsUI();
    }

    // Tách 1 linh kiện ra khỏi cụm
    function separatePartFromAssembly(part) {
      if (rotationPivotGroup) restoreRotationPivot();

      const { edges, descendants } = getKinematicBranch(part);
      const detachedJoints = new Set(edges
        .filter(edge => !edge.joint.id.startsWith('magnetic_joint_') &&
          edge.child === part && !descendants.has(edge.parent))
        .map(edge => edge.joint));
      const magneticJoints = joints.filter(joint => joint.id.startsWith('magnetic_joint_'));
      const magneticReleaseTargets = new Set();

      if (isMagneticPinPart(part)) {
        // Escape on a pin releases the pin itself from every connected part.
        magneticJoints.forEach(joint => {
          if (joint.pin === part || joint.partA === part || joint.partB === part) {
            detachedJoints.add(joint);
            const connectedPart = joint.partA === part ? joint.partB : joint.partA;
            if (connectedPart && connectedPart !== part) magneticReleaseTargets.add(connectedPart);
          }
        });
      } else {
        // When separating a structural part, keep each pin seated in that
        // part and break only the pin's joints to the rest of the assembly.
        const pinsToKeep = new Set(magneticJoints
          .filter(joint => (joint.partA === part || joint.partB === part) && joint.pin)
          .map(joint => joint.pin));
        pinsToKeep.forEach(pin => magneticReleaseTargets.add(pin));

        magneticJoints.forEach(joint => {
          if (!joint.pin && (joint.partA === part || joint.partB === part)) {
            detachedJoints.add(joint);
          } else if (pinsToKeep.has(joint.pin) && joint.partA !== part && joint.partB !== part) {
            detachedJoints.add(joint);
          }
        });
      }
      const oldGroup = part.parent?.userData.isAssemblyGroup && !part.parent.userData.isRotationPivotGroup
        ? part.parent
        : null;
      if (!detachedJoints.size && !oldGroup) return false;

      const affectedParts = new Set([part]);
      detachedJoints.forEach(joint => {
        [joint.partA, joint.partB, joint.pin, joint.kinematicParent, joint.kinematicChild]
          .filter(Boolean)
          .forEach(member => affectedParts.add(member));
      });

      if (oldGroup) {
        oldGroup.children.slice().forEach(member => scene.attach(member));
        oldGroup.parent?.remove(oldGroup);
      }
      scene.attach(part);
      part.updateMatrixWorld(true);

      joints = joints.filter(joint => !detachedJoints.has(joint));
      syncMagneticStateForParts(affectedParts);
      part.userData.magneticReleaseParts = [...magneticReleaseTargets];
      part.userData.magneticReleaseOrigin = magneticReleaseTargets.size
        ? part.getWorldPosition(new THREE.Vector3())
        : null;
      delete part.userData.kinematicParent;
      delete part.userData.kinematicChild;

      reconcileRigidAssemblies();
      part.updateMatrixWorld(true);
      updateJointsUI();
      if (selectedPart === part) {
        if (toolMode === 'select') transformControls.detach();
        else {
          transformControls.attach(getTransformTargetForPart(part, toolMode));
          transformControls.setMode(toolMode === 'rotate' ? 'rotate' : 'translate');
        }
      }
      return true;
    }

    // Đảm bảo khi rút 1 chốt ở giữa, nếu cụm bị gãy làm đôi thì sẽ tự tách thành 2 cụm độc lập
    function rebuildAssemblyGroups(groupParts) {
      groupParts.forEach(member => scene.attach(member));
      reconcileRigidAssemblies();
    }

    // HÀM HỖ TRỢ ĐỈNH CAO: Tự động tính toán để di chuyển cả Cụm hoặc Linh kiện đơn lẻ cực kỳ chuẩn xác
    function movePartToDesiredWorld(part, desiredWorldPos, desiredWorldQuat, options = {}) {
      const targetNode = getGroundConstraintRoot(part);
      part.updateMatrixWorld(true);
      targetNode.updateMatrixWorld(true);

      const currentPartWorldPosition = part.getWorldPosition(new THREE.Vector3());
      const currentPartWorldQuaternion = part.getWorldQuaternion(new THREE.Quaternion());
      const partLocalQuaternion = targetNode.getWorldQuaternion(new THREE.Quaternion())
        .invert()
        .multiply(currentPartWorldQuaternion);
      const desiredRootWorldQuaternion = desiredWorldQuat.clone()
        .multiply(partLocalQuaternion.invert());
      const parent = targetNode.parent;
      const parentWorldQuaternion = parent
        ? parent.getWorldQuaternion(new THREE.Quaternion())
        : new THREE.Quaternion();

      targetNode.quaternion.copy(parentWorldQuaternion.invert().multiply(desiredRootWorldQuaternion));
      targetNode.updateMatrixWorld(true);

      const rotatedPartWorldPosition = part.getWorldPosition(new THREE.Vector3());
      const desiredParentPosition = parent
        ? parent.worldToLocal(desiredWorldPos.clone())
        : desiredWorldPos.clone();
      const currentParentPosition = parent
        ? parent.worldToLocal(rotatedPartWorldPosition.clone())
        : rotatedPartWorldPosition;
      targetNode.position.add(desiredParentPosition.sub(currentParentPosition));
      targetNode.updateMatrixWorld(true);

      if (options.clampToGround !== false) clampPartToGround(part);
    }

    function snapPinToHole(pin, snap) {
      // Use the same transform used by the snap preview. Recalculating here
      // loses which side of a through-hole was selected and can flip the pin.
      const desiredWorldQuaternion = snap.desiredWorldQuaternion.clone();
      const desiredWorldPosition = snap.desiredWorldPosition.clone();

      const currentJoint = joints.find(j => j.id.startsWith('magnetic_joint_') &&
        j.partA === pin && j.socketA === snap.pinSocket &&
        j.partB === snap.targetPart && j.socketB === snap.targetSocket);
      if (!currentJoint && (isMagneticSocketOccupied(pin, snap.pinSocket) ||
        isMagneticSocketOccupied(snap.targetPart, snap.targetSocket))) return;

      movePartToDesiredWorld(pin, desiredWorldPosition, desiredWorldQuaternion);

      if (!currentJoint) {
        const jointId = createMagneticJointId();
        const pinHasSupport = getPinParticipants(pin).size > 0;
        joints.push({
          id: jointId,
          partA: pin,
          partB: snap.targetPart,
          socketA: snap.pinSocket,
          socketB: snap.targetSocket,
          pin,
          kinematicParent: pinHasSupport ? pin : snap.targetPart,
          kinematicChild: pinHasSupport ? snap.targetPart : pin
        });
        
        // ĐÃ XÓA LỆNH KHÓA CỤM Ở ĐÂY ĐỂ TRÁNH GIẬT CHUỘT
        pin.userData.magneticJointId = jointId;
        pin.userData.magneticSnapped = true;
        if (typeof updateJointsUI === 'function') updateJointsUI();
        straightenPinConnectedParts(pin);
      }
    }

    function snapComponentToPin(part, snap) {
      const desiredWorldQuaternion = snap.desiredWorldQuaternion.clone();
      const desiredWorldPosition = snap.desiredWorldPosition.clone();

      const currentJoint = joints.find(j => j.id.startsWith('magnetic_joint_') &&
        j.partA === snap.pin && j.socketA === snap.pinSocket &&
        j.partB === part && j.socketB === snap.componentSocket);
      const existingConnection = currentJoint || getPinJointConnecting(snap.pin, part);
      if (isMagneticSocketOccupied(part, snap.componentSocket, snap.pin) ||
        isMagneticSocketOccupied(snap.pin, snap.pinSocket, part)) return;

      movePartToDesiredWorld(part, desiredWorldPosition, desiredWorldQuaternion);

      if (existingConnection) {
        if (existingConnection.partA === snap.pin) {
          existingConnection.socketA = snap.pinSocket;
          existingConnection.socketB = snap.componentSocket;
        } else {
          existingConnection.socketB = snap.pinSocket;
          existingConnection.socketA = snap.componentSocket;
        }
        part.userData.magneticJointId = existingConnection.id;
        if (typeof updateJointsUI === 'function') updateJointsUI();
      } else {
        const jointId = createMagneticJointId();
        const pinHasSupport = getPinParticipants(snap.pin).size > 0;
        const kinematicParent = pinHasSupport ? snap.pin : part;
        const kinematicChild = pinHasSupport ? part : snap.pin;
        joints.push({
          id: jointId,
          partA: snap.pin,
          partB: part,
          socketA: snap.pinSocket,
          socketB: snap.componentSocket,
          pin: snap.pin,
          kinematicParent,
          kinematicChild
        });

        part.userData.magneticJointId = jointId;
        part.userData.magneticSnapped = true;
        if (typeof updateJointsUI === 'function') updateJointsUI();
      }
      if (!currentJoint) straightenPinConnectedParts(snap.pin);
    }

    function syncMagneticStateForParts(affectedParts) {
      affectedParts.forEach(affectedPart => {
        if (!affectedPart?.userData) return;
        const activeJoints = joints.filter(joint =>
          joint.id.startsWith('magnetic_joint_') &&
          (joint.partA === affectedPart || joint.partB === affectedPart || joint.pin === affectedPart));
        affectedPart.userData.magneticSnapped = activeJoints.length > 0;

        if (isMagneticPinPart(affectedPart)) {
          const mountJoint = activeJoints.find(joint => joint.pin === affectedPart && joint.partA === affectedPart);
          affectedPart.userData.magneticJointId = mountJoint?.id || null;
        } else {
          affectedPart.userData.magneticJointId = activeJoints[0]?.id || null;
        }
      });
    }

    function getKinematicEdges() {
      const edges = [];
      const addEdge = (parent, child, joint) => {
        if (parent && child && parent !== child) edges.push({ parent, child, joint });
      };

      joints.forEach(joint => {
        const { partA, partB, pin } = joint;
        if (joint.kinematicParent && joint.kinematicChild) {
          if (pin && pin !== joint.kinematicParent && pin !== joint.kinematicChild) {
            addEdge(joint.kinematicParent, pin, joint);
            addEdge(pin, joint.kinematicChild, joint);
          } else {
            addEdge(joint.kinematicParent, joint.kinematicChild, joint);
          }
        } else if (!pin) {
          addEdge(partA, partB, joint);
        } else if (pin === partA) {
          if (pin.userData?.magneticJointId && pin.userData.magneticJointId !== joint.id) {
            addEdge(pin, partB, joint);
          } else {
            addEdge(partB, pin, joint);
          }
        } else if (pin === partB) {
          if (pin.userData?.magneticJointId && pin.userData.magneticJointId !== joint.id) {
            addEdge(pin, partA, joint);
          } else {
            addEdge(partA, pin, joint);
          }
        } else {
          addEdge(partA, pin, joint);
          addEdge(pin, partB, joint);
        }
      });

      return edges;
    }

    function getKinematicBranch(root) {
      const edges = getKinematicEdges();
      const descendants = new Set([root]);
      const pending = [root];
      while (pending.length) {
        const parent = pending.pop();
        edges.forEach(edge => {
          if (edge.parent === parent && !descendants.has(edge.child)) {
            descendants.add(edge.child);
            pending.push(edge.child);
          }
        });
      }
      return { edges, descendants };
    }

    function updateRigidClusters() {
      const structuralParts = parts.filter(part => !isMagneticPinPart(part));
      const pairStatesByPart = getPinPairStates();

      const rigidNeighbors = new Map(structuralParts.map(part => [part, new Set()]));
      pairStatesByPart.forEach((partnerStates, part) => {
        partnerStates.forEach((state, partner) => {
          if (state.type !== 'rigid') return;
          rigidNeighbors.get(part).add(partner);
        });
      });

      const unassigned = new Set(structuralParts);
      while (unassigned.size) {
        const seed = unassigned.values().next().value;
        const cluster = [];
        const pending = [seed];
        while (pending.length) {
          const current = pending.pop();
          if (!unassigned.delete(current)) continue;
          cluster.push(current);
          rigidNeighbors.get(current).forEach(neighbor => pending.push(neighbor));
        }
        const clusterId = `rigid_cluster_${cluster.map(part => part.userData.id).sort().join('_')}`;
        cluster.forEach(part => { part.userData.clusterId = clusterId; });
      }

      return { structuralParts, pairStatesByPart };
    }
