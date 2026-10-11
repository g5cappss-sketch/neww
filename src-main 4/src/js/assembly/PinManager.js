(function (global) {
  const COMPATIBILITY = Object.freeze({
    round: Object.freeze(['round', 'any']),
    cross: Object.freeze(['cross', 'any']),
    square: Object.freeze(['square', 'any']),
    any: Object.freeze(['round', 'cross', 'square', 'any'])
  });

  const DIRECTION_ALIASES = {
    horizontal: 'horizontal',
    h: 'horizontal',
    side: 'horizontal',
    vertical: 'vertical',
    v: 'vertical',
    top: 'vertical',
    bottom: 'vertical'
  };

  function normalizeShape(shape) {
    return String(shape || 'round').trim().toLowerCase() || 'round';
  }

  function readVector(value, fallback) {
    if (Array.isArray(value)) {
      return new THREE.Vector3(Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0);
    }
    if (value && typeof value === 'object') {
      return new THREE.Vector3(Number(value.x) || 0, Number(value.y) || 0, Number(value.z) || 0);
    }
    return fallback.clone();
  }

  function normalizeDirection(value, normal) {
    const direction = DIRECTION_ALIASES[String(value || '').trim().toLowerCase()];
    return direction || (Math.abs(normal.y) < 0.7 ? 'horizontal' : 'vertical');
  }

  function isTruthy(value) {
    return value === true || value === 1 || ['true', '1', 'yes'].includes(String(value).toLowerCase());
  }

  class PinManager {
    static get COMPATIBILITY() {
      return COMPATIBILITY;
    }

    static normalizeShape(shape) {
      return normalizeShape(shape);
    }

    static canSnapShape(pinShape, holeShape) {
      const allowedHoles = COMPATIBILITY[normalizeShape(pinShape)] || [];
      return allowedHoles.includes(normalizeShape(holeShape));
    }

    static isSocketMarker(child) {
      if (!child?.isObject3D) return false;
      const data = child.userData || {};
      return isTruthy(data.isNode) ||
        isTruthy(data.isSocketNode) ||
        isTruthy(data.isSocket) ||
        isTruthy(data.isHole) ||
        ['socket', 'hole'].includes(String(data.nodeType || '').trim().toLowerCase()) ||
        /^(?:SOCKET_HOLE_|socket_|hole_)/i.test(child.name || '');
    }

    static extractSocketsFromGLB(gltfScene) {
      if (!gltfScene) return [];

      gltfScene.updateMatrixWorld(true);
      const inverseRootMatrix = gltfScene.matrixWorld.clone().invert();
      const sockets = [];

      gltfScene.traverse(child => {
        if (!PinManager.isSocketMarker(child)) return;

        const data = child.userData || {};
        const localMatrix = inverseRootMatrix.clone().multiply(child.matrixWorld);
        const position = new THREE.Vector3().setFromMatrixPosition(localMatrix);
        const normal = readVector(data.normal || data.localNormal, new THREE.Vector3(0, 0, 1));
        if (normal.lengthSq() < 1e-8) normal.set(0, 0, 1);
        normal.applyMatrix3(new THREE.Matrix3().getNormalMatrix(localMatrix)).normalize();

        const directionToken = String(child.name || '').match(/(?:^|_)(H|V)(?:_|$)/i)?.[1];
        const typeDirection = DIRECTION_ALIASES[String(data.type || '').trim().toLowerCase()];
        const dir = normalizeDirection(data.dir || data.orientation || data.direction || typeDirection || directionToken, normal);
        const parsedIndex = Number(String(child.name || '').match(/(\d+)\s*$/)?.[1]);
        const index = Number(data.index) > 0
          ? Math.floor(Number(data.index))
          : parsedIndex > 0
            ? parsedIndex
            : sockets.length + 1;

        sockets.push({
          index,
          x: position.x,
          y: position.y,
          z: position.z,
          dir,
          normal: normal.toArray(),
          shape: normalizeShape(data.shape),
          nodeType: data.nodeType || 'socket',
          desc: data.desc || `Lỗ #${index}`
        });
      });

      return sockets;
    }
  }

  global.PinManager = PinManager;
})(window);
