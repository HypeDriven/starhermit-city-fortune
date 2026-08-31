/* City Fortune — module bootstrap: provides THREE, then boots the UI.
 * Classic scripts (rng/rules/content/store/audio/game/render/ui) have already
 * run and registered their globals by the time this deferred module executes.
 */
import * as THREE from '../vendor/three.module.min.js';

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

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
