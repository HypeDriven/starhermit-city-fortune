/* City Fortune — module bootstrap: provides THREE (and its post-processing
 * addons), then boots the UI. Classic scripts (rng/rules/content/store/audio/
 * game/gfx/render/ui) have already run and registered their globals by the
 * time this deferred module executes.
 */
import * as THREE from 'three';

window.THREE = THREE;

function boot() {
  try {
    window.CFUI.boot();
  } catch (err) {
    var el = document.getElementById('screen-loading');
    if (el) {
      el.hidden = false;
      el.innerHTML = '<div class="panel center"><h1>City Fortune</h1><p>Something went wrong while starting: ' +
        String(err && err.message || err) + '</p></div>';
    }
    console.error(err);
  }
}

// Addons are an enhancement: if they fail to load, the renderer draws
// without post-processing and the Graphics panel says so.
import('./post.js')
  .then(function (addons) { window.CFThreeAddons = addons; })
  .catch(function () { window.CFThreeAddons = null; })
  .then(function () {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  });
