    function setSidebarTab(tabName) {
      const tabs = ['library', 'inspector', 'joints'];
      tabs.forEach(t => {
        const btn = document.getElementById('nav-btn-' + t);
        const pane = document.getElementById('tab-pane-' + t);
        if (btn && pane) {
          if (t === tabName) {
            btn.className = 'py-1.5 font-semibold rounded-lg bg-cyan-500 text-slate-950 transition-all flex items-center justify-center gap-1';
            pane.classList.remove('hidden');
          } else {
            btn.className = 'py-1.5 font-medium rounded-lg text-slate-400 hover:text-slate-200 transition-all flex items-center justify-center gap-1';
            pane.classList.add('hidden');
          }
        }
      });
    }

    window.addEventListener('DOMContentLoaded', () => {
      init3D();
      if (window.lucide) window.lucide.createIcons();
    });
