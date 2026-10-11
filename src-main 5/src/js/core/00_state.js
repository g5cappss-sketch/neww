    // --- HẰNG SỐ CƠ KHÍ CHUẨN ZMROBO (KICHTHUOC.PDF) ---
    const DV = 1.0;                 // 1DV = 47.0mm = 1 unit Three.js
    const BEAM_WIDTH = 1.0;         // W = 1DV
    const HOLE_RADIUS = 0.298;      // Ø28.0mm -> r = 14.0mm = 0.298DV
    const BEAM_HEIGHT = 1.0;         // H = 1DV
    const GRID_CELL_SIZE = 1.0;     // 1 ô lưới = 1DV
    const GRID_SIZE = 50 * GRID_CELL_SIZE;
    const GRID_BOUNDARY = GRID_SIZE / 2;
    const GRID_ORIGIN_OFFSET = GRID_CELL_SIZE / 2;
    const COLLISION_TOLERANCE = 0.06;

    let scene, camera, renderer, controls, transformControls, axesHelper;
    let parts = [];
    let joints = [];
    let selectedPart = null;
    let selectedPartHitbox = null;
    let isHitboxVisible = true;
    let customInventory = [];
    let libraryItemsByCategory = { beams: [], pins: [], motors: [], custom: [] };
    let activeLibraryFilter = 'beams';
    let pendingGLBImport = null;
    let history = [];
    let historyIndex = -1;
    let isExploded = false;
    let isAutoRotate = false;
    let toolMode = 'select'; // 'select' | 'translate' | 'rotate'
    let badgesMode = 'selected'; // 'selected' | 'all' | 'none'
    let angleSnapEnabled = true;
    let isManualJointRotationMode = false;

