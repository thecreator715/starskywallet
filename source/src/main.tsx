import { startRowGlow } from './live/rowglow';
import './index.css';
import {
  initWindowBindings,
  initStarfield,
  renderApp,
  connectNodes,
  getNet,
  panelBoot,
} from './starskyApp.ts';

initWindowBindings();
initStarfield();
getNet();
renderApp();
panelBoot();
startRowGlow();

