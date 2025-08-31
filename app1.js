// app3.js
// 正交相机 + 全屏平面，不会被边缘裁剪；正对屏幕的 2D 观感

import * as THREE from 'https://unpkg.com/three@0.161.0/build/three.module.js';

let renderer, scene, camera, raycaster;
let blob, u; // mesh + uniforms
let mouseNDC = new THREE.Vector2();
let mouseOnPlane = false;

const worldPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // z=0 平面（三维里的“画布”）
const followCenter = new THREE.Vector2(0, 0);
const targetCenter = new THREE.Vector2(0, 0);
const pointerXY = new THREE.Vector2(0, 0); // 在 z=0 平面的 (x,y)

let mousePower = 0;
let lastMoveT = 0;

init();
animate(0);

function init() {
    // 渲染器
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.setClearColor(0x0b0f14, 1);
    document.body.appendChild(renderer.domElement);

    scene = new THREE.Scene();

    // —— 正交相机：正对屏幕，没有透视畸变 ——
    camera = new THREE.OrthographicCamera();
    setupOrthoCamera();

    raycaster = new THREE.Raycaster();

    // 一点环境光（片元里主要用法线和 Fresnel 做“水感”）
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));

    // —— 全屏平面（比可视区大一圈，避免边缘裁剪）——
    const { viewW, viewH } = currentViewSize();
    const margin = 1.4; // 放大系数（>1 表示超出可视区）
    const planeW = viewW * margin;
    const planeH = viewH * margin;
    const RES = 240;
    const geom = new THREE.PlaneGeometry(planeW, planeH, RES, RES);
    // 正交相机朝 -Z 看，平面默认面朝 +Z，我们把它翻个面或翻转相机方向均可：
    // 这里让相机看向 z=0，平面放在 z=0，不需要旋转。

    // —— Uniforms ——（改成基于屏幕空间的 x,y）
    const R = Math.min(viewW, viewH) * 0.22; // 水滴半径相对屏幕比例
    const uniforms = {
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector2(0, 0) }, // 水滴中心 (x,y)
        uBlobR: { value: R },
        uEdgeSoft: { value: 0.25 },                    // 边缘柔化比例（相对半径）
        uMouse: { value: new THREE.Vector2(0, 0) }, // 鼠标 (x,y)
        uMousePower: { value: 0 },
        uMouseRadius: { value: R * 0.45 },                // 鼠标影响半径（绝对值）
        uMouseAmp: { value: R * 0.25 },                // 鼠标位移幅度（绝对值）
        uBaseAmp: { value: Math.min(viewW, viewH) * 0.012 }, // 基础微波幅度（随屏幕尺度）
        uTint: { value: new THREE.Color('#3aa7ff') },
        uBg: { value: new THREE.Color('#0b0f14') }
    };

    const material = new THREE.ShaderMaterial({
        uniforms,
        transparent: true,
        depthWrite: false,     // 关键：透明不写深度，避免自身遮挡/排序问题
        depthTest: true,
        vertexShader: /* glsl */`
      precision highp float;

      uniform float uTime;
      uniform vec2  uCenter;      // 屏幕平面上的中心 (x,y)
      uniform float uBlobR;
      uniform float uEdgeSoft;    // 相对半径
      uniform vec2  uMouse;       // 屏幕平面上的鼠标 (x,y)
      uniform float uMousePower;
      uniform float uMouseRadius; // 绝对距离
      uniform float uMouseAmp;    // 绝对位移
      uniform float uBaseAmp;

      varying vec3 vWorldPos;
      varying float vAlpha;

      float gaussian(float d, float r){
        return exp(-(d*d)/(r*r));
      }

      float waves(vec2 p, float t){
        float w = 0.0;
        w += sin(p.x*1.7 + t*1.2) * 0.55;
        w += sin(p.y*1.3 - t*1.5) * 0.45;
        w += sin((p.x+p.y)*0.9 + t*0.8) * 0.5;
        return w * uBaseAmp;
      }

      void main(){
        vec3 pos = position; // 平面在 z=0

        // 把顶点的 (x,y) 当作“屏幕空间”的坐标来做水滴圆遮罩
        vec2 xy = pos.xy; // z=0 平面

        float dCenter = length(xy - uCenter);
        float edge = smoothstep(uBlobR, uBlobR - uEdgeSoft*uBlobR, dCenter);
        vAlpha = edge;

        float t = uTime;
        float h = waves(xy, t) * edge;

        float dMouse = length(xy - uMouse);
        float g = gaussian(dMouse, uMouseRadius) * uMousePower * edge;
        h += g * uMouseAmp;

        pos.z += h; // 在正交相机下，z 作为“高度/位移”也可（法线仍可由导数得到）

        vWorldPos = (modelMatrix * vec4(pos, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
        fragmentShader: /* glsl */`
      precision highp float;

      uniform vec3 uTint;
      uniform vec3 uBg;

      varying vec3 vWorldPos;
      varying float vAlpha;

      float fresnel(vec3 n, vec3 v){
        return pow(1.0 - max(dot(n, v), 0.0), 2.0);
      }

      void main(){
        if(vAlpha <= 0.001) discard;

        vec3 dx = dFdx(vWorldPos);
        vec3 dy = dFdy(vWorldPos);
        vec3 n  = normalize(cross(dx, dy));

        vec3 V = normalize(cameraPosition - vWorldPos);

        float facing = clamp(n.z*0.7 + 0.3, 0.0, 1.0); // 正交下 z 法线也可作为“迎光”指标
        vec3 water = mix(uTint*0.45, uTint, facing);

        float f = fresnel(n, V);
        vec3 spec = mix(vec3(0.0), vec3(1.0), f*0.85);

        vec3 col = mix(uBg, water, 0.8) + spec*0.25;

        gl_FragColor = vec4(col, vAlpha);
      }
    `
    });

    blob = new THREE.Mesh(geom, material);
    blob.position.set(0, 0, 0); // 贴在 z=0 的“屏幕”
    u = uniforms;
    scene.add(blob);

    // 初始中心在屏幕中
    followCenter.set(0, 0);
    targetCenter.copy(followCenter);
    u.uCenter.value.copy(followCenter);

    addEventListeners();
    onResize();
}

function currentViewSize() {
    // 由正交相机的 4 个边推视口大小（世界单位）
    const viewW = camera.right - camera.left;
    const viewH = camera.top - camera.bottom;
    return { viewW, viewH };
}

function setupOrthoCamera() {
    const aspect = innerWidth / innerHeight;
    const halfH = 5;               // 世界单位（可理解为“虚拟像素高度的一半”）
    const halfW = halfH * aspect;

    // 让 z=0 位于可视中心，摄像机从 z=+10 看向原点
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.near = 0.01;
    camera.far = 50;
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
}

function addEventListeners() {
    addEventListener('resize', onResize, { passive: true });

    renderer.domElement.addEventListener('pointermove', (ev) => {
        // 标准化设备坐标
        const rect = renderer.domElement.getBoundingClientRect();
        mouseNDC.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        mouseNDC.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;

        // 射线与 z=0 平面求交
        raycaster.setFromCamera(mouseNDC, camera);
        const pt = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(worldPlane, pt)) {
            pointerXY.set(pt.x, pt.y);

            // 鼠标作用点
            u.uMouse.value.copy(pointerXY);

            // 让水滴中心跟随（想固定中心就注释下一行）
            targetCenter.copy(pointerXY);
            mouseOnPlane = true;

            const delta = pointerXY.clone().sub(followCenter).length();
            boost(THREE.MathUtils.clamp(0.25 + delta * 0.6, 0.25, 1.0));
            lastMoveT = performance.now();
        } else {
            mouseOnPlane = false;
        }
    });

    renderer.domElement.addEventListener('pointerleave', () => { mouseOnPlane = false; });
    renderer.domElement.addEventListener('pointerdown', () => boost(0.9));
    renderer.domElement.addEventListener('pointerup', () => boost(0.5));
}

function onResize() {
    renderer.setSize(innerWidth, innerHeight);

    // 重新配置正交相机
    setupOrthoCamera();

    // 让承载平面跟着可视区大小变化
    const { viewW, viewH } = currentViewSize();
    const margin = 1.4;
    const planeW = viewW * margin;
    const planeH = viewH * margin;

    // 重新生成几何（简单起见）
    const RES = 240;
    const geom = new THREE.PlaneGeometry(planeW, planeH, RES, RES);
    blob.geometry.dispose();
    blob.geometry = geom;

    // 半径和幅度也依据新视口更新，防止变形失真或边缘裁剪
    const R = Math.min(viewW, viewH) * 0.22;
    u.uBlobR.value = R;
    u.uMouseRadius.value = R * 0.45;
    u.uMouseAmp.value = R * 0.25;
    u.uBaseAmp.value = Math.min(viewW, viewH) * 0.012;
}

function boost(v) {
    mousePower = Math.min(1, Math.max(mousePower, v));
}

function animate(t) {
    requestAnimationFrame(animate);
    const dt = (t - (animate._t || t)) / 1000 || 0;
    animate._t = t;

    // 中心缓动（想让水滴固定在屏幕中心，把这一段注释掉，并设置 uCenter=(0,0)）
    const k = 1 - Math.pow(0.0025, dt);
    followCenter.lerp(targetCenter, k);
    u.uCenter.value.copy(followCenter);

    // 悬浮微动：正交相机下我们不移动物体位置，维持“二维”观感
    // （如果想上下漂一点，把 blob.position.y 改成依据时间的小幅 sin）

    // 力度衰减
    const noMoveFor = performance.now() - lastMoveT;
    const decay = mouseOnPlane && noMoveFor < 140 ? 0.93 : 0.84;
    mousePower *= Math.pow(decay, Math.max(dt * 60, 1));
    u.uMousePower.value = mousePower;

    u.uTime.value += dt;

    renderer.render(scene, camera);
}
