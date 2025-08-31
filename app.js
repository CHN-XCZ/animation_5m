/**
 * app.js — “零重力水团” · 圆 + 多三角楔（切线）
 * 性能修复：将所有重逻辑放到 rAF 循环里做（节流），pointermove 仅更新坐标；
 *           速度做 EMA 平滑；retarget 设最小间隔与最小位移阈值；复用临时向量。
 */

import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

/*==================== 可调参数（CSS 像素/秒） ====================*/
const RADIUS_CSS = 160;   // 圆半径
const CROSS_INNER_BAND_CSS = 30;    // 内侧容差带：上帧在 [R-带, R] 且本帧出圈 => 触发
const TWEEN_MS = 300;   // 跟随/回缩时长（可中断）
const SPEED_FOLLOW_MIN_CSSps = 700;   // 速度阈值（低于则脱离）
const MAX_OUT_OFFSET_CSS = 420;   // 允许拉到的最大半径：R + 此值
const MAX_SPIKES = 8;     // 同时存在的点上限
const AA_MIN_PX = 1.0;   // 抗锯齿最小宽度（设备像素）
const JOIN_BIAS_PX = 0.75;  // 三角楔向内微收缩，避免拼接发丝缝

// 性能/稳定性相关
const RETARGET_MIN_DELTA_PX_CSS = 4;   // 目标位移小于该值时本帧不 retarget（抖动抑制）
const RETARGET_MIN_INTERVAL_MS = 16;  // 两次 retarget 的最小时间间隔
const SPEED_EMA_ALPHA = 0.35;// 速度指数滑动平均的权重（0~1）

/*==================== three 基础对象 ====================*/
let renderer, scene, camera, mesh, material, clock;
let DPR = 1;

/*==================== 设备像素派生参数 ====================*/
let RADIUS = 160;
let CROSS_INNER_BAND = 24;
let SPEED_FOLLOW_MIN = 700; // 设备像素/秒
let MAX_OUT_OFFSET = 420;
let RETARGET_MIN_DELTA_PX = 4;

/*==================== Spike：一个“点”的状态机 ====================*/
const MODE_FOLLOW = 1;
const MODE_RETURN = 2;

class Spike {
    constructor(ax, ay) {
        this.apex = new THREE.Vector2(ax, ay);
        this.start = this.apex.clone();
        this.target = this.apex.clone();
        this.mode = MODE_FOLLOW;
        this.t = 0;
        this.duration = TWEEN_MS / 1000;
        this.lastRetargetMs = 0;
    }
    retarget(tx, ty, mode = MODE_FOLLOW, nowMs = 0) {
        this.mode = mode;
        this.start.copy(this.apex);
        this.target.set(tx, ty);
        this.t = 0;
        this.lastRetargetMs = nowMs;
    }
    update(dt, C, R) {
        this.t += dt / this.duration;
        const t = (this.t >= 1) ? 1 : this.t;
        const k = 1 - Math.pow(1 - t, 3); // easeOutCubic
        this.apex.set(
            this.start.x + (this.target.x - this.start.x) * k,
            this.start.y + (this.target.y - this.start.y) * k
        );
        if (this.mode === MODE_RETURN) {
            const d = this.apex.distanceTo(C);
            if (d <= R + 0.6 || t >= 1) return true; // 结束并移除
        }
        return false;
    }
}

/*==================== Uniforms（传给着色器） ====================*/
const MAX_S = MAX_SPIKES;
const uniforms = {
    u_resolution: { value: new THREE.Vector2() },
    u_center: { value: new THREE.Vector2() },
    u_radius: { value: 0.0 },
    u_aa: { value: AA_MIN_PX },
    u_joinBias: { value: JOIN_BIAS_PX },
    u_spikeCount: { value: 0 },
    u_spikes: { value: Array.from({ length: MAX_S }, () => new THREE.Vector2(1e9, 1e9)) },
};

/*==================== 运行时状态 ====================*/
let spikes = [];
let activeFollowerIndex = -1;              // 当前可跟随的唯一 Spike
const mouse = { cssX: 0, cssY: 0, devX: 0, devY: 0, tsMs: 0, valid: false };
let prevFrame = { devX: NaN, devY: NaN, dist: NaN, tsMs: 0, speedEMA: 0 };

/* 复用临时向量（减少 GC） */
const tmpV1 = new THREE.Vector2();
const tmpV2 = new THREE.Vector2();

/*==================== 初始化 ====================*/
init();
animate();

function init() {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x0b0f14, 1);
    document.body.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const geo = new THREE.PlaneGeometry(2, 2);
    material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: /* glsl */`
      varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }
    `,
        fragmentShader: /* glsl */`
      precision highp float;
      #define MAX_SPIKES ${MAX_S}

      uniform vec2  u_resolution;
      uniform vec2  u_center;
      uniform float u_radius;
      uniform float u_aa;
      uniform float u_joinBias;
      uniform int   u_spikeCount;
      uniform vec2  u_spikes[MAX_SPIKES];

      float sdCircle(vec2 p, vec2 c, float r){ return length(p - c) - r; }

      float sdTriangle(vec2 p, vec2 a, vec2 b, vec2 c){
        vec2 e0=b-a, e1=c-b, e2=a-c;
        vec2 v0=p-a, v1=p-b, v2=p-c;
        vec2 pq0=v0 - e0*clamp(dot(v0,e0)/dot(e0,e0),0.0,1.0);
        vec2 pq1=v1 - e1*clamp(dot(v1,e1)/dot(e1,e1),0.0,1.0);
        vec2 pq2=v2 - e2*clamp(dot(v2,e2)/dot(e2,e2),0.0,1.0);
        float s = sign(e0.x*e2.y - e0.y*e2.x);
        vec2  d = min( min( vec2(dot(pq0,pq0), s*(v0.x*e0.y - v0.y*e0.x)),
                            vec2(dot(pq1,pq1), s*(v1.x*e1.y - v1.y*e1.x)) ),
                            vec2(dot(pq2,pq2), s*(v2.x*e2.y - v2.y*e2.x)) );
        return -sqrt(d.x) * sign(d.y);
      }

      void circleTangentPoints(vec2 C, float R, vec2 M, out vec2 T1, out vec2 T2){
        vec2 v = M - C;
        float d = length(v);
        if(d <= R + 1e-4){ T1=C; T2=C; return; }
        vec2 u = v / d;
        vec2 n = vec2(-u.y, u.x);
        float cosphi = R / d;
        float sinphi = sqrt(max(0.0, 1.0 - cosphi*cosphi));
        vec2 q1 = u * cosphi + n * sinphi;
        vec2 q2 = u * cosphi - n * sinphi;
        T1 = C + R * q1; T2 = C + R * q2;
      }

      void main(){
        vec2 p = gl_FragCoord.xy;

        float d = sdCircle(p, u_center, u_radius);

        for(int i=0; i<MAX_SPIKES; i++){
          if(i >= u_spikeCount) break;
          vec2 M = u_spikes[i];
          if(M.x > 9.0e8) continue;
          if(distance(M, u_center) <= u_radius + 1.0) continue;

          vec2 T1, T2; circleTangentPoints(u_center, u_radius, M, T1, T2);
          float dTri = sdTriangle(p, M, T1, T2);
          dTri -= u_joinBias;
          d = min(d, dTri);
        }

        float aa = max(fwidth(d), ${AA_MIN_PX.toFixed(1)});
        float alpha = 1.0 - smoothstep(0.0, aa, d);
        if(alpha < 0.001) discard;
        gl_FragColor = vec4(vec3(1.0), 1.0);
      }
    `,
    });

    mesh = new THREE.Mesh(geo, material);
    scene.add(mesh);

    clock = new THREE.Clock();

    // pointermove 只记录坐标 & 时间
    window.addEventListener('pointermove', (e) => {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.cssX = e.clientX - rect.left;
        mouse.cssY = e.clientY - rect.top;
        mouse.devX = mouse.cssX * DPR;
        mouse.devY = (rect.height - mouse.cssY) * DPR; // 翻到“左下原点”
        mouse.tsMs = performance.now();
        mouse.valid = true;
    }, { passive: true });

    window.addEventListener('pointerleave', () => {
        // 当前跟随者（若有）回缩
        const C = uniforms.u_center.value, R = uniforms.u_radius.value;
        if (activeFollowerIndex !== -1) {
            const s = spikes[activeFollowerIndex];
            const v = tmpV1.copy(s.apex).sub(C);
            const dir = v.length() > 1e-4 ? v.normalize() : tmpV2.set(1, 0);
            const edge = tmpV2.copy(C).add(dir.multiplyScalar(R));
            s.retarget(edge.x, edge.y, MODE_RETURN, performance.now());
            activeFollowerIndex = -1;
        }
        mouse.valid = false;
    }, { passive: true });

    window.addEventListener('resize', onResize, { passive: true });

    onResize();
}

/*==================== 尺寸变化 ====================*/
function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);

    DPR = renderer.getPixelRatio();
    uniforms.u_resolution.value.set(w * DPR, h * DPR);

    // 圆心（左下原点）
    const cx = Math.floor((w * 0.5) * DPR);
    const cyTop = Math.floor((h * 0.5) * DPR);
    const cyGL = h * DPR - cyTop;
    uniforms.u_center.value.set(cx, cyGL);

    // CSS → 设备像素
    RADIUS = RADIUS_CSS * DPR;
    CROSS_INNER_BAND = CROSS_INNER_BAND_CSS * DPR;
    SPEED_FOLLOW_MIN = SPEED_FOLLOW_MIN_CSSps * DPR;
    MAX_OUT_OFFSET = MAX_OUT_OFFSET_CSS * DPR;
    RETARGET_MIN_DELTA_PX = RETARGET_MIN_DELTA_PX_CSS * DPR;

    uniforms.u_radius.value = RADIUS;
    uniforms.u_aa.value = AA_MIN_PX;
    uniforms.u_joinBias.value = JOIN_BIAS_PX;
}

/*==================== 主循环（节流后的所有逻辑） ====================*/
function animate() {
    const dt = Math.min(0.033, clock.getDelta());
    const nowMs = performance.now();

    const C = uniforms.u_center.value;
    const R = uniforms.u_radius.value;

    // 若有鼠标数据：计算半径、速度（EMA），并做穿越/跟随判定
    if (mouse.valid) {
        const mx = mouse.devX, my = mouse.devY;
        const dCurr = tmpV1.set(mx - C.x, my - C.y).length();

        // 以“帧”为单位计算速度（比事件更稳），并做 EMA 平滑
        let speed = 0;
        if (Number.isFinite(prevFrame.devX)) {
            const dx = mx - prevFrame.devX;
            const dy = my - prevFrame.devY;
            const dtFrame = Math.max(1e-3, (nowMs - prevFrame.tsMs) / 1000);
            speed = Math.sqrt(dx * dx + dy * dy) / dtFrame;
            prevFrame.speedEMA = THREE.MathUtils.lerp(prevFrame.speedEMA || 0, speed, SPEED_EMA_ALPHA);
        } else {
            prevFrame.speedEMA = 0;
        }

        // —— 1) 由内向外穿越触发（带内侧容差）——
        let crossedOut = false;
        if (Number.isFinite(prevFrame.dist)) {
            const wasInside = prevFrame.dist <= R + 1e-3;
            const nearInside = prevFrame.dist >= (R - CROSS_INNER_BAND);
            const nowOutside = dCurr > R + 1e-3;
            crossedOut = wasInside && nearInside && nowOutside;
        }
        if (crossedOut) {
            // 新建 Spike（从 0.8R 处“长出”）
            const dir = tmpV2.set(mx - C.x, my - C.y).normalize();
            const start = tmpV1.copy(C).add(dir.clone().multiplyScalar(R * 0.80));
            const s = new Spike(start.x, start.y);
            spikes.push(s);
            activeFollowerIndex = spikes.length - 1;

            // 首帧跟随/回缩判定
            const radialOffset = dCurr - R;
            if (prevFrame.speedEMA >= SPEED_FOLLOW_MIN && radialOffset <= MAX_OUT_OFFSET) {
                s.retarget(mx, my, MODE_FOLLOW, nowMs);
            } else {
                const edge = tmpV1.copy(C).add(dir.multiplyScalar(R));
                s.retarget(edge.x, edge.y, MODE_RETURN, nowMs);
                activeFollowerIndex = -1;
            }

            // 控制上限
            if (spikes.length > MAX_SPIKES) {
                // 优先移除最早的“回缩中”Spike；若都在跟随，则移除最早一个
                let idx = spikes.findIndex(x => x.mode === MODE_RETURN);
                if (idx === -1) idx = 0;
                if (idx === activeFollowerIndex) activeFollowerIndex = -1;
                spikes.splice(idx, 1);
            }
        }

        // —— 2) 当前跟随者（若有）：节流 retarget，避免事件风暴卡顿 —— 
        if (activeFollowerIndex !== -1) {
            const s = spikes[activeFollowerIndex];
            const radialOffset = dCurr - R;

            // 跟随条件：速度足够 && 半径不超过允许
            if (prevFrame.speedEMA >= SPEED_FOLLOW_MIN && radialOffset <= MAX_OUT_OFFSET) {
                // 只有当移动“显著”或间隔到达才 retarget（避免每帧重置）
                const movedEnough =
                    Math.hypot(mx - s.target.x, my - s.target.y) >= RETARGET_MIN_DELTA_PX;
                const intervalOk = (nowMs - s.lastRetargetMs) >= RETARGET_MIN_INTERVAL_MS;

                if (movedEnough && intervalOk) {
                    s.retarget(mx, my, MODE_FOLLOW, nowMs);
                }
            } else {
                // 脱离：改为回缩
                const v = tmpV1.copy(s.apex).sub(C);
                const dir = v.length() > 1e-4 ? v.normalize() : tmpV2.set(mx - C.x, my - C.y).normalize();
                const edge = tmpV2.copy(C).add(dir.multiplyScalar(R));
                s.retarget(edge.x, edge.y, MODE_RETURN, nowMs);
                activeFollowerIndex = -1;
            }
        }

        // 更新“上一帧”数据
        prevFrame.devX = mx; prevFrame.devY = my; prevFrame.dist = dCurr; prevFrame.tsMs = nowMs;
    }

    // —— 更新所有 Spike（回缩完成的移除）——
    for (let i = 0; i < spikes.length; i++) {
        const s = spikes[i];
        const done = s.update(dt, uniforms.u_center.value, R);
        if (done) {
            if (i === activeFollowerIndex) activeFollowerIndex = -1;
            spikes.splice(i, 1); i--;
        }
    }

    // 写 uniforms
    uniforms.u_spikeCount.value = Math.min(spikes.length, MAX_SPIKES);
    for (let i = 0; i < MAX_S; i++) {
        const v = uniforms.u_spikes.value[i];
        if (i < spikes.length) v.copy(spikes[i].apex);
        else v.set(1e9, 1e9);
    }

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
}
