import { createRayPointer, Pointer } from '@pmndrs/pointer-events';
import {
  BufferAttribute,
  Color,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
  WebXRSpaceEventMap,
  XRHandSpace,
} from 'three';
import { forceScale, setForceScale } from '../state';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/examples/jsm/webxr/XRHandModelFactory.js';
import { HAND_INTERACTION_DISTANCE, InteractionManager, MAX_INTERACTION_DISTANCE } from '../tools/interaction-manager';
import { AvatarComponentsState } from '../core/avatar-state';
import { CursorState } from '../core/primitives';
import { ColocationManager } from './colocation';
import { SqueezeManipulation } from './manipulation';
import {
  endPanelGrabFor,
  getGrabHandle,
  resetPanelPlacement,
  startPanelGrab,
  UIKitButton,
  uikitButtons,
} from '../ui/xrUI';
import {
  customGrabHandle,
  endCustomPanelGrabFor,
  resetCustomPanelPlacement,
  startCustomPanelGrab,
} from '../ui/xrCustomUI';

type XRPointer = {
  controller: Group<WebXRSpaceEventMap>;
  pointer: Pointer;
  rayLine: Mesh;
  tipMarker: Mesh;
};


const PINCH_START_DISTANCE = 0.015;
const PINCH_END_DISTANCE = 0.025;

const PANEL_GRAB_FOLLOW_RATE = 85;
const HAND_TRACKING_GRACE_MS = 250;

interface XRInputOptions {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  objects: Object3D;
  panelRot: Object3D;
  calibratedSpace: Object3D;
  interactionManager: InteractionManager;
  getColocationMode: () => boolean;
}

export class XRInputManager {
  readonly controllers: Group<WebXRSpaceEventMap>[] = [];
  readonly hands: XRHandSpace[] = [];
  readonly colocation: ColocationManager;
  readonly manipulation: SqueezeManipulation;

  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;

  private readonly panelRot: Object3D;
  private readonly interactionManager: InteractionManager;

  private readonly pointers: XRPointer[] = [];
  private readonly controllerTips = new Map<Group<WebXRSpaceEventMap>, Object3D>();
  private readonly handModels: Object3D[] = [];
  private readonly pinchAnchors: Object3D[] = [];
  private readonly grabAnchors: Object3D[] = [];
  private readonly staticTips: Object3D[] = [];
  private readonly lastTrackedAt = [0, 0];
  private lastFrameTime = 0;
  private smoothAlpha = 0;

  private panelRoot: Object3D | undefined;
  private extraPanelRoot: Object3D | undefined;

  private activeSession: XRSession | null = null;

  private recenter: () => void = () => {};

  private scaleTick = 0;
  private scaleTime = 0;
  private lastUpdateTime = 0;

  private readonly hoverButtonPos = new Vector3();
  private readonly hoverControllerPos = new Vector3();
  private readonly calibratedInverse = new Matrix4();
  private readonly componentMatrix = new Matrix4();
  private readonly tempPosA = new Vector3();
  private readonly tempPosB = new Vector3();
  private readonly tempQuat = new Quaternion();
  private readonly tempScale = new Vector3();
  private readonly mirrorMatrix = new Matrix4().makeScale(-1, 1, 1);
  private readonly avatarFacingCorrection = new Quaternion(0, 1, 0, 0);

  constructor(options: XRInputOptions) {
    this.renderer = options.renderer;
    this.scene = options.scene;
    this.camera = options.camera;
    this.panelRot = options.panelRot;
    this.interactionManager = options.interactionManager;

    this.colocation = new ColocationManager({
      renderer: options.renderer,
      scene: options.scene,
      calibratedSpace: options.calibratedSpace,
      getColocationMode: options.getColocationMode,
    });
    this.manipulation = new SqueezeManipulation(options.objects);

    this.setupControllers();
    this.renderer.xr.addEventListener('sessionstart', this.onSessionStart);
    this.renderer.xr.addEventListener('sessionend', this.onSessionEnd);
  }

  setRecenter(handler: () => void) {
    this.recenter = handler;
  }

  getRightController(): Group<WebXRSpaceEventMap> | undefined {
    return this.controllers.find((controller) => controller.userData.handedness === 'right');
  }

  private setHeldButton(group: Group<WebXRSpaceEventMap>, button: string, held: boolean) {
    const heldButtons = group.userData.heldButtons as Set<string> | undefined;
    if (!heldButtons) {
      return;
    }
    if (held) {
      heldButtons.add(button);
    } else {
      heldButtons.delete(button);
    }
  }

  collectCursors(): CursorState[] {
    const cursors: CursorState[] = [];
    if (!this.renderer.xr.isPresenting) {
      return cursors;
    }

    const session = this.renderer.xr.getSession();

    this.colocation.calibratedSpace.updateWorldMatrix(true, false);
    this.calibratedInverse.copy(this.colocation.calibratedSpace.matrixWorld).invert();

    for (let i = 0; i < this.controllers.length; i += 1) {
      const controller = this.controllers[i];

      const handedness = controller.userData.handedness;
      if (handedness !== 'left' && handedness !== 'right') {
        continue;
      }

      if (controller.userData.isHand && this.hands[i]?.joints['wrist']?.visible !== true) {
        continue;
      }

      const buttons = new Set<string>();
      const hasGamepad = this.readControllerButtons(session, handedness, buttons);
      if (!hasGamepad) {
        const controllerButtons = controller.userData.heldButtons as Set<string> | undefined;
        if (controllerButtons) {
          for (const button of controllerButtons) {
            buttons.add(button);
          }
        }
      }

      const cursorObject: Object3D = this.controllerTips.get(controller) ?? controller;
      cursorObject.updateWorldMatrix(true, false);
      this.componentMatrix.multiplyMatrices(this.calibratedInverse, cursorObject.matrixWorld);
      // cursor poses are shared in the calibrated space using the unity convention.
      // this client's calibrated space is right-handed, so mirror the pose
      // at X (position x -> -x, quaternion (x, y, z, w) -> (x, -y, -z, w))
      this.componentMatrix.premultiply(this.mirrorMatrix);
      this.componentMatrix.decompose(this.tempPosA, this.tempQuat, this.tempScale);

      cursors.push({
        handedness,
        position: [this.tempPosA.x, this.tempPosA.y, this.tempPosA.z],
        rotation: [this.tempQuat.x, this.tempQuat.y, this.tempQuat.z, this.tempQuat.w],
        heldbuttons: [...buttons],
        joystick: this.readJoystick(session, handedness),
      });
    }

    return cursors;
  }

  private readJoystick(session: XRSession | null, handedness: 'left' | 'right'): [number, number] {
    if (!session) {
      return [0, 0];
    }

    for (const source of session.inputSources) {
      if (source.handedness !== handedness || !source.gamepad) {
        continue;
      }

      const axes = source.gamepad.axes;
      if (axes.length > 3) {
        return [axes[2], axes[3]];
      }
      if (axes.length > 1) {
        return [axes[0], axes[1]];
      }
    }

    return [0, 0];
  }

  private readControllerButtons(session: XRSession | null, handedness: 'left' | 'right', buttons: Set<string>): boolean {
    if (!session) {
      return false;
    }

    for (const source of session.inputSources) {
      if (source.handedness !== handedness || !source.gamepad) {
        continue;
      }

      // xr-standard gamepad mapping: 0=trigger, 1=squeeze, 4=A/X, 5=B/Y
      const gamepadButtons = source.gamepad.buttons;
      if (gamepadButtons[0]?.pressed) {
        buttons.add('trigger');
      }
      if (gamepadButtons[1]?.pressed) {
        buttons.add('grip');
      }
      if (gamepadButtons[4]?.pressed) {
        buttons.add('primary');
      }
      if (gamepadButtons[5]?.pressed) {
        buttons.add('secondary');
      }
      return true;
    }

    return false;
  }

  collectAvatarComponents(): AvatarComponentsState {
    if (!this.renderer.xr.isPresenting) {
      return [];
    }

    const components: AvatarComponentsState = [];
    this.colocation.calibratedSpace.updateWorldMatrix(true, false);
    this.calibratedInverse.copy(this.colocation.calibratedSpace.matrixWorld).invert();

    const xrCamera = this.renderer.xr.getCamera();
    xrCamera.updateWorldMatrix(true, false);
    this.addAvatarComponent(components, 'headset', xrCamera);

    for (let i = 0; i < 2; i += 1) {
      const controller = this.controllers[i];
      if (!controller) {
        continue;
      }
      if (controller.userData.isHand) {
        // publish the wrist pose only while the hand is actually tracked
        const wrist = this.hands[i]?.joints['wrist'];
        if (wrist?.visible) {
          wrist.updateWorldMatrix(true, false);
          this.addAvatarComponent(components, i === 0 ? 'hand.left' : 'hand.right', wrist);
        }
      } else if (controller.visible) {
        controller.updateWorldMatrix(true, false);
        this.addAvatarComponent(components, i === 0 ? 'hand.left' : 'hand.right', controller);
      }
    }

    return components;
  }

  update(panelRoot: Object3D | undefined, extraPanelRoot?: Object3D) {
    this.panelRoot = panelRoot;
    this.extraPanelRoot = extraPanelRoot;

    if (!this.renderer.xr.isPresenting) {
      for (const { rayLine, tipMarker } of this.pointers) {
        rayLine.visible = false;
        tipMarker.visible = false;
      }
      return;
    }

    const now = performance.now() / 1000;
    const frameDt = this.lastFrameTime > 0 ? Math.min(0.1, now - this.lastFrameTime) : 1 / 60;
    this.lastFrameTime = now;
    this.smoothAlpha = 1 - Math.exp(-frameDt * PANEL_GRAB_FOLLOW_RATE);

    for (let i = 0; i < this.controllers.length; i += 1) {
      this.applyInputMode(i);
      const isHand = this.controllers[i].userData.isHand === true;
      // hands interact at the pinch point
      this.pointers[i].tipMarker.visible = !isHand;
      if (isHand) {
        this.updateHandSlot(i);
      }
    }

    for (const controller of this.controllers) {
      this.updateUIButtonHover(controller);
    }

    this.manipulation.update();
    this.updateRayPointers(panelRoot, extraPanelRoot);
    this.interactionManager.updateActive();
    this.interactionManager.updateHoverHighlight();
    this.updateForceScaleFromThumbstick();
    this.colocation.updateAnchorPose();
  }

  private updateForceScaleFromThumbstick() {
    const now = performance.now() / 1000;
    const dt = this.lastUpdateTime > 0 ? Math.min(0.067, now - this.lastUpdateTime) : 0;
    this.lastUpdateTime = now;

    const x = this.getRightThumbstickX();
    const increase = x > 0.5;
    const decrease = x < -0.5;
    const isScaling = increase || decrease;

    this.scaleTime = isScaling ? this.scaleTime + dt : 0;
    this.scaleTick = isScaling ? this.scaleTick + dt : 0;

    if (this.scaleTick > 0.1) {
      const sign = increase ? 1 : -1;
      const acceleration = Math.pow(2, Math.floor(this.scaleTime));
      const change = sign * acceleration;
      const newScale = Math.round(Math.min(10000, Math.max(1, forceScale + change)));
      setForceScale(newScale);
      this.scaleTick -= 0.1;
    }
  }

  private getRightThumbstickX(): number {
    const session = this.renderer.xr.getSession();
    if (!session) return 0;
    for (const source of session.inputSources) {
      if (source.handedness === 'right' && source.gamepad) {
        const axes = source.gamepad.axes;
        // WebXR standard gamepad mapping: axes[2] = thumbstick X, axes[0] = touchpad X
        if (axes.length > 2) return axes[2];
        if (axes.length > 0) return axes[0];
      }
    }
    return 0;
  }

  private setupControllers() {
    const modelFactory = new XRControllerModelFactory();
    const handModelFactory = new XRHandModelFactory();

    for (let i = 0; i < 2; i += 1) {
      const grip = this.renderer.xr.getControllerGrip(i);
      grip.add(modelFactory.createControllerModel(grip));
      this.scene.add(grip);

      const controller = this.renderer.xr.getController(i);
      this.controllers.push(controller);
      this.scene.add(controller);

      const hand = this.renderer.xr.getHand(i);
      const handModel = handModelFactory.createHandModel(hand, 'mesh');
      handModel.visible = false;
      hand.add(handModel);
      this.hands.push(hand);
      this.handModels.push(handModel);
      this.scene.add(hand);

      const pinchAnchor = new Object3D();
      pinchAnchor.visible = false;
      this.pinchAnchors.push(pinchAnchor);
      this.scene.add(pinchAnchor);


      const grabAnchor = new Object3D();
      grabAnchor.visible = false;
      this.grabAnchors.push(grabAnchor);
      this.scene.add(grabAnchor);

      controller.addEventListener('connected', (event) => {
        controller.userData.handedness = event.data.handedness;
        controller.userData.heldButtons = new Set<string>();
        controller.userData.isHand = Boolean(event.data.hand);
        controller.userData.pinching = false;
        controller.userData.selectActive = false;
        this.applyInputMode(i);
      });
      controller.addEventListener('disconnected', () => {
        this.releaseSlot(i);
        controller.userData.handedness = undefined;
        controller.userData.heldButtons = undefined;
        controller.userData.isHand = false;
        controller.userData.pinching = false;
        this.handModels[i].visible = false;
        this.applyInputMode(i);
      });

      this.addClicker(controller);

      controller.addEventListener('squeezestart', () => {
        this.manipulation.startGrip(controller);
        this.setHeldButton(controller, 'grip', true);
        this.setHeldButton(controller, 'secondary', true);
      });
      controller.addEventListener('squeezeend', () => {
        this.manipulation.endGrip(controller);
        this.setHeldButton(controller, 'grip', false);
        this.setHeldButton(controller, 'secondary', false);
      });

      this.setupRayPointer(controller, i);
    }
  }

  private addClicker(group: Group<WebXRSpaceEventMap>) {
    group.userData.hoveredUIKit = undefined;
    group.addEventListener('select', () => {
      const hovered = group.userData.hoveredUIKit as UIKitButton | undefined;
      hovered?.onClick();
    });
  }

  private setupRayPointer(controller: Group<WebXRSpaceEventMap>, handIndex: number) {
    const side = handIndex === 0 ? -0.02 : 0.02;

    const tip = new Object3D();
    tip.position.set(side, 0, -0.08);
    controller.add(tip);
    this.staticTips[handIndex] = tip;
    this.controllerTips.set(controller, tip);
    this.interactionManager.registerControllerTip(controller, tip);

    const tipMarker = new Mesh(
      new SphereGeometry(0.008, 12, 12),
      new MeshBasicMaterial({
        color: 0x00ff66,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      }),
    );
    tipMarker.renderOrder = 1000;
    tipMarker.frustumCulled = false;
    tip.add(tipMarker);

    const rayOrigin = new Object3D();
    rayOrigin.position.set(side, 0, -0.05);
    controller.add(rayOrigin);

    const rayLength = 1.0;
    const rayGeometry = new CylinderGeometry(0.003, 0.003, rayLength, 8);
    rayGeometry.rotateX(Math.PI / 2);
    rayGeometry.translate(0, 0, -rayLength / 2);

    const alphaCount = rayGeometry.attributes.position.count;
    const alphaValues = new Float32Array(alphaCount);
    const rayPositions = rayGeometry.attributes.position.array;
    for (let i = 0; i < alphaCount; i += 1) {
      const z = rayPositions[(i * 3) + 2];
      alphaValues[i] = 1 - (Math.abs(z) / rayLength);
    }
    rayGeometry.setAttribute('alpha', new BufferAttribute(alphaValues, 1));

    const rayMaterial = new ShaderMaterial({
      transparent: true,
      depthTest: false,
      uniforms: {
        color: { value: new Color(0xffffff) },
        opacity: { value: 0.9 },
      },
      vertexShader: `
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 color;
        uniform float opacity;
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(color, opacity * vAlpha);
        }
      `,
    });

    const rayMesh = new Mesh(rayGeometry, rayMaterial);
    rayMesh.renderOrder = 999;
    rayMesh.frustumCulled = false;
    rayMesh.visible = false;
    rayOrigin.add(rayMesh);

    const pointer = createRayPointer(
      () => this.camera,
      { current: rayOrigin },
      { pressing: false },
      { minDistance: 0 },
      'xr-ray',
    );

    controller.addEventListener('selectstart', () => {
      if (controller.userData.isHand) return;
      this.onSlotSelectStart(handIndex);
    });

    controller.addEventListener('selectend', () => {
      if (controller.userData.isHand) return;
      this.onSlotSelectEnd(handIndex);
    });

    this.pointers.push({ controller, pointer, rayLine: rayMesh, tipMarker });
  }

  private onSlotSelectStart(index: number) {
    const controller = this.controllers[index];
    const { pointer } = this.pointers[index];

    controller.userData.selectActive = true;
    this.setHeldButton(controller, 'primary', true);
    this.setHeldButton(controller, 'trigger', true);

    pointer.down({ timeStamp: performance.now(), button: 0 });

    const intersection = pointer.getIntersection();
    const handle = getGrabHandle();
    if (handle && intersection && this.isDescendantOf(intersection.object, handle)) {
      startPanelGrab(controller, this.panelRot);
      return;
    }
    if (customGrabHandle && intersection && this.isDescendantOf(intersection.object, customGrabHandle)) {
      startCustomPanelGrab(controller);
      return;
    }
    // interacting with a menu must not grab molecules
    if (intersection && this.isPanelObject(intersection.object)) {
      return;
    }

    this.interactionManager.start(controller);
  }

  private onSlotSelectEnd(index: number) {
    const controller = this.controllers[index];
    const { pointer } = this.pointers[index];

    controller.userData.selectActive = false;
    this.setHeldButton(controller, 'primary', false);
    this.setHeldButton(controller, 'trigger', false);

    pointer.up({ timeStamp: performance.now(), button: 0 });
    endPanelGrabFor(controller);
    endCustomPanelGrabFor(controller);
    this.interactionManager.end(controller);
  }

  private releaseSlot(index: number) {
    const controller = this.controllers[index];
    if (controller.userData.selectActive) {
      this.onSlotSelectEnd(index);
    }
    endPanelGrabFor(controller);
    endCustomPanelGrabFor(controller);
    this.interactionManager.end(controller);
    this.manipulation.endGrip(controller);
  }

  private applyInputMode(index: number) {
    const controller = this.controllers[index];
    const isHand = controller.userData.isHand === true;
    controller.userData.grabAnchor = isHand ? this.grabAnchors[index] : undefined;
    const tip = isHand ? this.pinchAnchors[index] : this.staticTips[index];
    if (!tip || this.controllerTips.get(controller) === tip) {
      return;
    }
    this.controllerTips.set(controller, tip);
    this.interactionManager.registerControllerTip(
      controller,
      tip,
      isHand ? HAND_INTERACTION_DISTANCE : MAX_INTERACTION_DISTANCE,
    );
  }

  private updateHandSlot(index: number) {
    const controller = this.controllers[index];
    const hand = this.hands[index];
    const joints = hand.joints;
    const thumbTip = joints['thumb-tip'];
    const indexTip = joints['index-finger-tip'];
    const wrist = joints['wrist'];

    // hide the hand mesh as soon as tracking is lost
    this.handModels[index].visible = wrist?.visible === true;

    const anchor = this.pinchAnchors[index];
    const grabAnchor = this.grabAnchors[index];
    const wasPinching = controller.userData.pinching === true;
    let pinching = false;
    let tracked = false;

    if (thumbTip?.visible && indexTip?.visible) {
      tracked = true;
      this.lastTrackedAt[index] = performance.now();
      thumbTip.getWorldPosition(this.tempPosA);
      indexTip.getWorldPosition(this.tempPosB);
      const distance = this.tempPosA.distanceTo(this.tempPosB);
      pinching = wasPinching ? distance < PINCH_END_DISTANCE : distance < PINCH_START_DISTANCE;

      anchor.position.copy(this.tempPosA).add(this.tempPosB).multiplyScalar(0.5);
      if (wrist?.visible) {
        wrist.getWorldQuaternion(anchor.quaternion);
      }
    }

    const frozen = !tracked && wasPinching
      && performance.now() - this.lastTrackedAt[index] < HAND_TRACKING_GRACE_MS;
    if (frozen) {
      pinching = true;
    }
    anchor.visible = tracked || frozen;

    if (tracked) {
      if (pinching && wasPinching) {
        // smooth the grab anchor while dragging to filter joint jitter
        grabAnchor.position.lerp(anchor.position, this.smoothAlpha);
      } else {
        grabAnchor.position.copy(anchor.position);
      }
    }

    if (pinching !== wasPinching) {
      controller.userData.pinching = pinching;
      if (pinching) {
        this.onSlotSelectStart(index);
      } else {
        this.onSlotSelectEnd(index);
      }
    }
  }

  private isPanelObject(object: Object3D): boolean {
    return Boolean(
      (this.panelRoot && this.isDescendantOf(object, this.panelRoot)) ||
      (this.extraPanelRoot && this.isDescendantOf(object, this.extraPanelRoot)),
    );
  }

  private updateUIButtonHover(group: Group<WebXRSpaceEventMap>) {
    group.userData.hoveredUIKit = undefined;
    group.getWorldPosition(this.hoverControllerPos);

    for (const button of uikitButtons) {
      button.container.getWorldPosition(this.hoverButtonPos);
      if (this.hoverButtonPos.distanceTo(this.hoverControllerPos) < 0.1) {
        group.userData.hoveredUIKit = button;
      }
    }
  }

  private updateRayPointers(panelRoot: Object3D | undefined, extraPanelRoot?: Object3D) {
    for (const { pointer, rayLine } of this.pointers) {
      pointer.move(this.scene, { timeStamp: performance.now() });
      const intersection = pointer.getIntersection();
      const hitsPanel = Boolean(
        intersection &&
        ((panelRoot && this.isDescendantOf(intersection.object, panelRoot)) ||
          (extraPanelRoot && this.isDescendantOf(intersection.object, extraPanelRoot))),
      );

      if (hitsPanel && intersection) {
        rayLine.visible = true;
        rayLine.scale.z = Math.min(intersection.distance, 2);
        continue;
      }

      rayLine.visible = false;
      rayLine.scale.z = 0.15;
    }
  }

  private onSessionStart = () => {
    this.activeSession = this.renderer.xr.getSession();
    if (this.activeSession) {
      this.colocation.onSessionStart(this.activeSession);
    }
    resetPanelPlacement();
    resetCustomPanelPlacement();
    window.setTimeout(() => this.recenter(), 500);
  };

  private onSessionEnd = () => {
    if (this.activeSession) {
      this.colocation.onSessionEnd(this.activeSession);
    }
    this.activeSession = null;
    for (let i = 0; i < this.controllers.length; i += 1) {
      this.releaseSlot(i);
      this.handModels[i].visible = false;
    }
    this.manipulation.reset();
  };

  private addAvatarComponent(components: AvatarComponentsState, name: string, source: Object3D) {
    this.componentMatrix.multiplyMatrices(this.calibratedInverse, source.matrixWorld);
    this.componentMatrix.premultiply(this.mirrorMatrix);
    this.componentMatrix.decompose(this.tempPosA, this.tempQuat, this.tempScale);
    this.tempQuat.multiply(this.avatarFacingCorrection).normalize();

    components.push({
      name,
      position: [this.tempPosA.x, this.tempPosA.y, this.tempPosA.z],
      rotation: [this.tempQuat.x, this.tempQuat.y, this.tempQuat.z, this.tempQuat.w],
    });
  }

  private isDescendantOf(child: Object3D, parent: Object3D): boolean {
    let cursor: Object3D | null = child;
    while (cursor) {
      if (cursor === parent) {
        return true;
      }
      cursor = cursor.parent;
    }
    return false;
  }
}
