# Craft3DPro source layout

The monolithic HTML source was separated into `index.html`, `css/style.css`, and ordered JavaScript files under `js/core`, `js/assembly`, and `js/data`.

The JavaScript files use classic script tags and are loaded in their original order. This keeps the existing global functions and inline HTML event handlers working without changing their behavior. The third-party CDN dependencies from the original file remain in `index.html`.

Open `index.html` in a browser with internet access for the CDN libraries. The original source remains at `C:\Users\admin\Downloads\file tách.txt`.
