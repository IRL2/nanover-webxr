import { Container, Text as UIText } from '@pmndrs/uikit';
import { Slider } from '@pmndrs/uikit-default';
import { Group, Matrix4, Object3D, PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import { UIKitButton, uikitButtons, showPanelInDesktop } from './xrUI';
import {
  CustomPanel,
  CustomPanelElement,
  formatSliderValue,
  getCustomPanels,
  getVariable,
  runPanelCommand,
  setVariable,
  subscribeCustomUI,
} from './customUI';

const PANEL_WIDTH = 0.6;
const SIDE_OFFSET = 0.95;
const BUTTON_COLOR = 0x546E7A;
const ACTIVE_BUTTON_SHADE = 0x303030;
const HANDLE_IDLE = 0x888888;
const HANDLE_HOVER = 0xaaaaaa;
const HANDLE_ACTIVE = 0x4488ff;

export const customPanelRot = new Object3D();
export let customControlPanel: Container | undefined;
export let customGrabHandle: Container | undefined;

let contentContainer: Container | undefined;
let customButtons: UIKitButton[] = [];
let sliderUpdaters: (() => void)[] = [];

let isGrabbed = false;
let hasBeenPlaced = false;
let initialPositionSet = false;
let grabbingController: Group | null = null;
// hand grabs follow position only and keep facing the head (no wrist rotation)
let grabHeadFacing = false;
const grabWorldOffset = new Vector3();

const offsetMatrix = new Matrix4();
const worldMatrix = new Matrix4();
const parentInverse = new Matrix4();
const basisMatrix = new Matrix4();
const targetPos = new Vector3();
const targetRot = new Quaternion();
const targetScale = new Vector3();
const forward = new Vector3();
const right = new Vector3();
const xAxis = new Vector3();
const yAxis = new Vector3(0, 1, 0);
const panelPos = new Vector3();
const camPos = new Vector3();
const handlePos = new Vector3();
const controllerPos = new Vector3();

export function isCustomPanelBeingGrabbed(): boolean {
  return isGrabbed;
}

// hands grab at the (smoothed) pinch point, controllers at their own origin
function getGrabSourcePosition(controller: Group, out: Vector3) {
  const anchor = controller.userData.grabAnchor as Object3D | undefined;
  return (anchor ?? controller).getWorldPosition(out);
}

export function startCustomPanelGrab(controller: Group) {
  if (isGrabbed) return;
  isGrabbed = true;
  grabbingController = controller;
  grabHeadFacing = controller.userData.isHand === true;

  customPanelRot.updateMatrixWorld(true);
  controller.updateMatrixWorld(true);

  if (grabHeadFacing) {
    customPanelRot.getWorldPosition(grabWorldOffset);
    getGrabSourcePosition(controller, targetPos);
    grabWorldOffset.sub(targetPos);
  } else {
    offsetMatrix.copy(controller.matrixWorld).invert().multiply(customPanelRot.matrixWorld);
  }
  customGrabHandle?.setProperties({ backgroundColor: HANDLE_ACTIVE });
}

export function endCustomPanelGrab() {
  if (!isGrabbed) return;
  isGrabbed = false;
  grabbingController = null;
  grabHeadFacing = false;
  hasBeenPlaced = true;
  customGrabHandle?.setProperties({ backgroundColor: HANDLE_IDLE });
}

export function endCustomPanelGrabFor(controller: Group) {
  if (isGrabbed && grabbingController === controller) {
    endCustomPanelGrab();
  }
}

export function resetCustomPanelPlacement() {
  hasBeenPlaced = false;
  initialPositionSet = false;
}

function updateGrab(camera: PerspectiveCamera) {
  if (!isGrabbed || !grabbingController) return;

  grabbingController.updateMatrixWorld(true);

  if (grabHeadFacing) {
    // follow the hand position, but keep the panel facing the head
    getGrabSourcePosition(grabbingController, targetPos);
    targetPos.add(grabWorldOffset);
    customPanelRot.position.copy(targetPos);
    if (customPanelRot.parent) {
      customPanelRot.parent.updateWorldMatrix(true, false);
      customPanelRot.parent.worldToLocal(customPanelRot.position);
    }
    camera.getWorldPosition(camPos);
    camPos.y = targetPos.y;
    customPanelRot.lookAt(camPos);
    return;
  }

  worldMatrix.multiplyMatrices(grabbingController.matrixWorld, offsetMatrix);
  if (customPanelRot.parent) {
    parentInverse.copy(customPanelRot.parent.matrixWorld).invert();
    worldMatrix.premultiply(parentInverse);
  }
  worldMatrix.decompose(targetPos, targetRot, targetScale);
  customPanelRot.position.copy(targetPos);

  // keep the panel upright: only yaw follows the controller
  forward.set(0, 0, 1).applyQuaternion(targetRot);
  forward.y = 0;
  if (forward.lengthSq() > 0.001) {
    forward.normalize();
    xAxis.crossVectors(yAxis, forward).normalize();
    customPanelRot.quaternion.setFromRotationMatrix(basisMatrix.makeBasis(xAxis, yAxis, forward));
  }
  customPanelRot.scale.copy(targetScale);
}

function createButton(label: string, onClick: () => void): UIKitButton {
  const container = new Container({
    width: '100%',
    height: 10,
    backgroundColor: BUTTON_COLOR,
    borderRadius: 2,
    justifyContent: 'center',
    alignItems: 'center',
    cursor: 'pointer',
    pointerEvents: 'auto',
  });
  const text = new UIText({ fontSize: 3, color: 0xffffff, anchorX: 'center', anchorY: 'middle' });
  text.setProperties({ text: label } as any);
  container.add(text);

  const button: UIKitButton = { container, onClick, originalColor: BUTTON_COLOR };
  container.addEventListener('click', onClick);
  container.addEventListener('pointerenter', () => {
    container.setProperties({ backgroundColor: BUTTON_COLOR + ACTIVE_BUTTON_SHADE } as any);
  });
  container.addEventListener('pointerleave', () => {
    container.setProperties({ backgroundColor: BUTTON_COLOR } as any);
  });
  uikitButtons.push(button);
  customButtons.push(button);
  return button;
}

function createSlider(element: Extract<CustomPanelElement, { type: 'slider' }>): Container {
  const wrapper = new Container({ flexDirection: 'column', width: '100%', gap: 2 });
  const labelText = new UIText({ fontSize: 2.6, color: 0xcccccc });
  const slider = new Slider();
  const step = element.step ?? (element.integer ? 1 : (element.max - element.min) / 100);

  const refresh = () => {
    const value = Number(getVariable(element.variable));
    labelText.setProperties({
      text: `${element.label}: ${formatSliderValue(element, value)}`,
    } as any);
    if (Number.isFinite(value)) {
      slider.setProperties({ value } as any);
    }
  };

  slider.setProperties({
    width: '100%',
    min: element.min,
    max: element.max,
    step,
    pointerEvents: 'auto',
    onValueChange: (value: number) => {
      setVariable(element.variable, element.integer ? Math.round(value) : value);
    },
  } as any);
  slider.thumb?.setProperties({
    borderColor: 0x888888,
    borderWidth: 1,
    height: 12,
    width: 12,
    transformTranslateX: -6,
    transformTranslateY: -4,
  } as any);
  slider.track?.setProperties({ height: 4 } as any);

  refresh();
  sliderUpdaters.push(refresh);
  wrapper.add(labelText, slider);
  return wrapper;
}

function createElement(element: CustomPanelElement): Container | UIText {
  switch (element.type) {
    case 'header': {
      const text = new UIText({ fontSize: 3.4, color: 0xffffff, marginTop: 2 });
      text.setProperties({ text: element.label } as any);
      return text;
    }
    case 'button':
      return createButton(element.label, () => {
        void runPanelCommand(element.command, element.arguments);
      }).container;
    case 'slider':
      return createSlider(element);
  }
}

function createPanel(panel: CustomPanel): Container {
  const container = new Container({ flexDirection: 'column', width: '100%', gap: 4 });
  const title = new UIText({ fontSize: 2.4, color: 0xaaaaaa });
  title.setProperties({ text: panel.label.toUpperCase() } as any);
  container.add(title);
  for (const element of panel.elements) {
    container.add(createElement(element));
  }
  return container;
}

function rebuild() {
  if (!contentContainer) return;

  for (const button of customButtons) {
    const index = uikitButtons.indexOf(button);
    if (index >= 0) uikitButtons.splice(index, 1);
  }
  customButtons = [];
  sliderUpdaters = [];
  contentContainer.clear();

  for (const panel of getCustomPanels()) {
    contentContainer.add(createPanel(panel));
  }
}

export function setupXRCustomUI(scene: Scene) {
  customControlPanel = new Container({
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  });
  customControlPanel.visible = false;
  customPanelRot.add(customControlPanel);
  scene.add(customPanelRot);

  contentContainer = new Container({
    sizeX: PANEL_WIDTH,
    flexDirection: 'column',
    backgroundColor: 0x1a1a1a,
    padding: 5,
    gap: 6,
    borderRadius: 4,
  });

  const handle = new Container({
    width: 15,
    height: 3,
    backgroundColor: HANDLE_IDLE,
    borderRadius: 2,
    cursor: 'grab',
    pointerEvents: 'auto',
  });
  customGrabHandle = handle;
  handle.addEventListener('pointerenter', () => handle.setProperties({ backgroundColor: HANDLE_HOVER }));
  handle.addEventListener('pointerleave', () => {
    if (!isGrabbed) handle.setProperties({ backgroundColor: HANDLE_IDLE });
  });
  handle.addEventListener('pointerdown', () => {
    (handle as any).userData.grabRequested = true;
  });
  handle.addEventListener('pointerup', () => {
    endCustomPanelGrab();
    (handle as any).userData.grabRequested = false;
  });

  customControlPanel.add(contentContainer, handle);

  subscribeCustomUI((change) => {
    if (change === 'panels') {
      rebuild();
    } else {
      sliderUpdaters.forEach((update) => update());
    }
  });
  rebuild();
}

function placeInitially(camera: PerspectiveCamera, isPresenting: boolean) {
  camera.getWorldDirection(forward);
  if (isPresenting) forward.y = 0;
  forward.normalize();
  right.crossVectors(forward, yAxis).normalize();

  customPanelRot.position.copy(camera.position);
  if (isPresenting) {
    customPanelRot.position.y -= 0.6;
    customPanelRot.position.addScaledVector(forward, 0.8);
    customPanelRot.position.addScaledVector(right, SIDE_OFFSET);
    camPos.copy(camera.position);
    camPos.y = customPanelRot.position.y;
    customPanelRot.lookAt(camPos);
  } else {
    customPanelRot.position.addScaledVector(forward, 2);
    customPanelRot.position.addScaledVector(right, SIDE_OFFSET);
    customPanelRot.lookAt(camera.position);
  }
}

export function updateXRCustomUI(
  dt: number,
  isPresenting: boolean,
  camera: PerspectiveCamera,
  controllers: Group[] = [],
) {
  const panel = customControlPanel;
  if (!panel || !customGrabHandle) return;

  const visible = (isPresenting || showPanelInDesktop) && getCustomPanels().length > 0;
  panel.visible = visible;
  if (!visible) {
    endCustomPanelGrab();
    customGrabHandle.userData.grabRequested = false;
    return;
  }
  panel.update(dt * 1000);

  if ((customGrabHandle as any).userData.grabRequested && !isGrabbed) {
    customGrabHandle.getWorldPosition(handlePos);
    let closest: Group | null = null;
    let minDistance = 0.2;
    for (const controller of controllers) {
      controller.getWorldPosition(controllerPos);
      const distance = controllerPos.distanceTo(handlePos);
      if (distance < minDistance) {
        minDistance = distance;
        closest = controller;
      }
    }
    if (closest) {
      startCustomPanelGrab(closest);
      (customGrabHandle as any).userData.grabRequested = false;
    }
  }

  updateGrab(camera);

  customPanelRot.getWorldPosition(panelPos);
  camera.getWorldPosition(camPos);
  const deltaY = camPos.y - panelPos.y;
  const distXZ = Math.hypot(camPos.x - panelPos.x, camPos.z - panelPos.z);
  panel.rotation.x = isPresenting ? -Math.atan2(deltaY, distXZ) : 0;

  if (isGrabbed || (isPresenting && hasBeenPlaced)) return;
  if (isPresenting) {
    if (!initialPositionSet) {
      placeInitially(camera, true);
      initialPositionSet = true;
    }
  } else {
    placeInitially(camera, false);
  }
}
