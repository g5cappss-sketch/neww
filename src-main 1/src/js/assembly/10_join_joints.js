    function updateJointsUI() {
      const tree = document.getElementById('scene-tree-list');
      if (!tree) return;
      tree.replaceChildren();

      if (!parts.length) {
        const emptyItem = document.createElement('li');
        const emptyLabel = document.createElement('span');
        emptyLabel.className = 'scene-tree-empty';
        emptyLabel.textContent = 'Chưa có linh kiện trên Scene';
        emptyItem.appendChild(emptyLabel);
        tree.appendChild(emptyItem);
        return;
      }

      const connectedParts = new Map(parts.map(part => [part, new Set()]));
      joints.forEach(joint => {
        const members = [joint.partA, joint.partB, joint.pin].filter(part => connectedParts.has(part));
        members.forEach(member => members.forEach(part => {
          if (member !== part) connectedParts.get(member).add(part);
        }));
      });

      const childrenByParent = new Map(parts.map(part => [part, new Set()]));
      const incomingParts = new Set();
      if (typeof getKinematicEdges === 'function') {
        getKinematicEdges().forEach(edge => {
          if (!childrenByParent.has(edge.parent) || !childrenByParent.has(edge.child)) return;
          childrenByParent.get(edge.parent).add(edge.child);
          incomingParts.add(edge.child);
        });
      }

      const renderedParts = new Set();
      const appendPartNode = (list, part, component, branch) => {
        if (branch.has(part) || renderedParts.has(part)) return;
        const nextBranch = new Set(branch);
        nextBranch.add(part);
        renderedParts.add(part);

        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `scene-tree-part${part === selectedPart ? ' is-selected' : ''}`;
        button.title = part.userData?.name || 'Linh kiện';
        button.setAttribute('aria-label', `Chọn ${button.title}`);

        const icon = document.createElement('i');
        icon.dataset.lucide = part.userData?.isPin ? 'bluetooth' : 'box';
        icon.className = 'h-3.5 w-3.5';
        const label = document.createElement('span');
        label.textContent = part.userData?.name || 'Linh kiện';
        button.append(icon, label);
        button.addEventListener('click', () => selectPart(part));
        item.appendChild(button);

        const childParts = [...(childrenByParent.get(part) || [])]
          .filter(child => component.has(child) && !renderedParts.has(child));
        if (childParts.length) {
          const childList = document.createElement('ul');
          childParts.forEach(child => appendPartNode(childList, child, component, nextBranch));
          item.appendChild(childList);
        }
        list.appendChild(item);
      };

      const remainingParts = new Set(parts);
      let clusterNumber = 0;
      while (remainingParts.size) {
        const seed = remainingParts.values().next().value;
        const component = new Set([seed]);
        const pending = [seed];
        while (pending.length) {
          const current = pending.pop();
          connectedParts.get(current).forEach(neighbor => {
            if (!component.has(neighbor)) {
              component.add(neighbor);
              pending.push(neighbor);
            }
          });
        }
        component.forEach(part => remainingParts.delete(part));

        if (component.size === 1) {
          appendPartNode(tree, seed, component, new Set());
          continue;
        }

        clusterNumber++;
        const clusterItem = document.createElement('li');
        clusterItem.className = 'scene-tree-cluster';
        const details = document.createElement('details');
        details.open = true;
        const summary = document.createElement('summary');
        const clusterIcon = document.createElement('i');
        clusterIcon.dataset.lucide = 'boxes';
        clusterIcon.className = 'h-3.5 w-3.5 text-cyan-300';
        const clusterLabel = document.createElement('span');
        clusterLabel.textContent = `Cụm ${clusterNumber}`;
        const clusterSize = document.createElement('small');
        clusterSize.textContent = `${component.size} part`;
        summary.append(clusterIcon, clusterLabel, clusterSize);

        const childList = document.createElement('ul');
        const roots = [...component].filter(part => !incomingParts.has(part) ||
          ![...component].some(parent => childrenByParent.get(parent)?.has(part)));
        roots.forEach(root => appendPartNode(childList, root, component, new Set()));
        [...component].forEach(part => appendPartNode(childList, part, component, new Set()));
        details.append(summary, childList);
        clusterItem.appendChild(details);
        tree.appendChild(clusterItem);
      }

      if (window.lucide) window.lucide.createIcons();
    }

    function removeJoint(jointId) {
      joints = joints.filter(j => j.id !== jointId);
      reconcileRigidAssemblies();
      updateJointsUI();
      recordHistoryState();
      showToast("Đã tháo khớp ghép");
    }

