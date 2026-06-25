import { useState, useRef, useCallback, useEffect } from "react";

// ── Animation engine ───────────────────────────────────────────────────────────
// Drives per-node animated values (opacity, radius, glowOpacity) outside React
// render cycles for silky performance. Uses requestAnimationFrame + spring easing.

function easeInOutCubic(t) {
  return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2;
}
function easeOutBack(t) {
  const c1=1.70158, c3=c1+1;
  return 1 + c3*Math.pow(t-1,3) + c1*Math.pow(t-1,2);
}

class NodeAnimator {
  constructor() {
    this.targets   = {}; // id → { opacity, radius, glow, pulse }
    this.current   = {}; // id → same, current animated values
    this.rafId     = null;
    this.breatheId = null; // separate RAF for the idle breathe loop
    this.listeners = [];
    this.running   = false;
    this.breatheNode = null; // which node is breathing
    this.breatheStart = null;
  }
  init(nodes, sizes, getPos) {
    nodes.forEach(n => {
      const r = sizes[n.id] ?? 22;
      const p = getPos ? getPos(n.id) : { x: n.x, y: n.y };
      this.targets[n.id]  = { opacity:1, radius:r, glow:0, pulse:0, x:p.x, y:p.y };
      this.current[n.id]  = { opacity:1, radius:r, glow:0, pulse:0, x:p.x, y:p.y };
    });
  }
  setTargets(newTargets) {
    Object.entries(newTargets).forEach(([id, vals]) => {
      if (this.targets[id]) Object.assign(this.targets[id], vals);
    });
    this.start();
  }
  // Slow sine-wave glow on the selected node — runs its own loop so it never stops
  startBreathe(id) {
    this.breatheNode  = id;
    this.breatheStart = performance.now();
    if (this.breatheId) cancelAnimationFrame(this.breatheId);
    const PERIOD = 2600; // ms per full cycle — slow and calm
    const MIN_GLOW = 0.25, MAX_GLOW = 0.72;
    const tick = (now) => {
      if (this.breatheNode !== id) return; // node changed, stop this loop
      const t = ((now - this.breatheStart) % PERIOD) / PERIOD; // 0→1
      // sine goes 0→1→0; offset so it starts at mid-glow
      const sine = 0.5 + 0.5 * Math.sin(2 * Math.PI * t - Math.PI / 2);
      const glowVal = MIN_GLOW + sine * (MAX_GLOW - MIN_GLOW);
      if (this.current[id]) {
        this.current[id].glow = glowVal;
        this.notify();
      }
      this.breatheId = requestAnimationFrame(tick);
    };
    this.breatheId = requestAnimationFrame(tick);
  }
  stopBreathe() {
    this.breatheNode = null;
    if (this.breatheId) { cancelAnimationFrame(this.breatheId); this.breatheId = null; }
  }
  start() {
    if (this.running) return;
    this.running = true;
    const SPEED = 0.055;
    const tick = () => {
      let anyMoving = false;
      Object.keys(this.current).forEach(id => {
        const cur = this.current[id];
        const tgt = this.targets[id];
        // Skip glow for the breathing node — breathe loop owns it
        const keys = id === this.breatheNode
          ? ["opacity","radius","pulse","x","y"]
          : ["opacity","radius","glow","pulse","x","y"];
        keys.forEach(k => {
          const diff = tgt[k] - cur[k];
          if (Math.abs(diff) > 0.001) {
            cur[k] += diff * SPEED;
            anyMoving = true;
          } else {
            cur[k] = tgt[k];
          }
        });
      });
      this.notify();
      if (anyMoving) {
        this.rafId = requestAnimationFrame(tick);
      } else {
        this.running = false;
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }
  subscribe(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(l=>l!==fn); }; }
  notify() { this.listeners.forEach(fn => fn({...this.current})); }
  destroy() {
    if (this.rafId)     cancelAnimationFrame(this.rafId);
    if (this.breatheId) cancelAnimationFrame(this.breatheId);
  }
}

// ── Edge wave animator ──────────────────────────────────────────────────────
// Isolated, single-purpose engine just for the line-glow feature:
// on selection, glow travels outward along each connecting line (staggered by
// distance from the selected node), then settles into a slow ambient pulse that
// continues on those same lines for as long as the node stays selected.
// Lighten a hex color toward white by a 0–1 amount — used so the glow uses each
// node's own cluster color, brightened, rather than a separate universal color.
function lightenHex(hex, amount) {
  const h = hex.replace("#","");
  const r = parseInt(h.substring(0,2),16);
  const g = parseInt(h.substring(2,4),16);
  const b = parseInt(h.substring(4,6),16);
  const lr = Math.round(r + (255-r)*amount);
  const lg = Math.round(g + (255-g)*amount);
  const lb = Math.round(b + (255-b)*amount);
  return `rgb(${lr},${lg},${lb})`;
}

function easeOutQuad(t) { return 1 - (1-t)*(1-t); }
function easeOutSine(t) { return Math.sin((t * Math.PI) / 2); }

class EdgeWaveAnimator {
  constructor() {
    this.rafId = null;
    this.listeners = [];
    this.selectedId = null;
    this.travel = {};      // edgeKey → 0..1 travel progress (during the initial wave)
    this.ambient = {};     // edgeKey → 0..1 current ambient pulse glow
    this.delays = {};      // edgeKey → ms delay before travel starts
    this.durations = {};   // edgeKey → ms travel duration
    this.phase = {};       // edgeKey → phase offset for ambient pulse (so lines don't pulse in lockstep)
    this.mode = "idle";    // "idle" | "traveling" | "ambient" | "fading"
    this.startTime = 0;
    this.fadeStart = 0;
  }
  key(a, b) { return `${a}|${b}`; }
  get(a, b) {
    const k1 = this.key(a,b), k2 = this.key(b,a);
    return this.travel[k1] ?? this.travel[k2] ?? this.ambient[k1] ?? this.ambient[k2] ?? 0;
  }
  isTraveling() { return this.mode === "traveling"; }

  // Begin the wave: glow travels from selectedId outward to each connected node,
  // staggered by straight-line distance (closer = sooner & faster).
  select(selectedId, nodes, edges) {
    this.stop();
    this.selectedId = selectedId;
    this.mode = "traveling";
    this.startTime = performance.now();
    this.travel = {};
    this.ambient = {};
    this.delays = {};
    this.durations = {};
    this.phase = {};

    const src = nodes.find(n => n.id === selectedId);
    if (!src) return;

    const myEdges = edges.filter(([a,b]) => a === selectedId || b === selectedId);
    const distances = myEdges.map(([a,b]) => {
      const otherId = a === selectedId ? b : a;
      const other = nodes.find(n => n.id === otherId);
      return other ? Math.hypot(other.x - src.x, other.y - src.y) : 0;
    });
    const minD = distances.length ? Math.min(...distances) : 0;
    const maxD = distances.length ? Math.max(...distances) : 1;
    const range = Math.max(1, maxD - minD);

    myEdges.forEach(([a,b], i) => {
      const k = this.key(a,b);
      const d = distances[i];
      const t = (d - minD) / range; // 0 (closest) → 1 (farthest)
      this.delays[k]    = Math.round(t * 400);          // closer lines start sooner
      this.durations[k] = Math.round(700 + t * 500);    // slow headlight travel — not a fast fill
      this.travel[k] = 0;
      this.phase[k]  = (i * 173) % 3000; // stable per-edge phase offset for ambient pulse
    });

    const tick = (now) => {
      if (this.selectedId !== selectedId) return;
      const elapsed = now - this.startTime;
      let stillTraveling = false;

      myEdges.forEach(([a,b]) => {
        const k = this.key(a,b);
        const localT = (elapsed - this.delays[k]) / this.durations[k];
        const progress = Math.max(0, Math.min(1, localT));
        this.travel[k] = easeOutSine(progress);
        if (progress < 1) stillTraveling = true;
      });

      this.notify();

      if (stillTraveling) {
        this.rafId = requestAnimationFrame(tick);
      } else {
        // Wave has fully landed on every connected line — hand off to ambient pulse
        this.mode = "ambient";
        this.startAmbient(myEdges);
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  // Slow ambient pulse on all currently-connected lines, gently phase-offset so
  // they don't all brighten/dim in perfect unison — feels organic, not mechanical.
  startAmbient(myEdges) {
    const PERIOD = 2800;
    const MIN = 0.30, MAX = 0.85;
    const ambientStart = performance.now();
    const tick = (now) => {
      if (this.mode !== "ambient") return;
      myEdges.forEach(([a,b]) => {
        const k = this.key(a,b);
        const t = (((now - ambientStart) + (this.phase[k]||0)) % PERIOD) / PERIOD;
        const sine = 0.5 + 0.5 * Math.sin(2*Math.PI*t - Math.PI/2);
        this.ambient[k] = MIN + sine * (MAX - MIN);
        this.travel[k] = 1; // keep travel at full so get() returns ambient seamlessly
      });
      this.notify();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  // Reverse / deselect: fade all active line glow out smoothly rather than cutting it
  deselect() {
    if (this.mode === "idle") return;
    const fadeFrom = { ...this.travel };
    const ambFrom  = { ...this.ambient };
    this.mode = "fading";
    const fadeStart = performance.now();
    const FADE_DUR = 260;
    const tick = (now) => {
      if (this.mode !== "fading") return;
      const t = Math.min(1, (now - fadeStart) / FADE_DUR);
      Object.keys(fadeFrom).forEach(k => {
        const base = Math.max(fadeFrom[k] ?? 0, ambFrom[k] ?? 0);
        this.travel[k]  = base * (1 - t);
        this.ambient[k] = 0;
      });
      this.notify();
      if (t < 1) {
        this.rafId = requestAnimationFrame(tick);
      } else {
        this.stop();
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop() {
    this.mode = "idle";
    this.selectedId = null;
    this.travel = {};
    this.ambient = {};
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    this.notify();
  }
  subscribe(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(l=>l!==fn); }; }
  notify() { this.listeners.forEach(fn => fn()); }
  destroy() { if (this.rafId) cancelAnimationFrame(this.rafId); }
}

// Cluster-aware sizing: recompute node radii based only on within-cluster degrees
function computeClusterSizes(selectedId, nodes, edges, baseRanges) {
  const cluster = new Set();
  if (selectedId) {
    cluster.add(selectedId);
    edges.forEach(([a,b]) => { if(a===selectedId) cluster.add(b); if(b===selectedId) cluster.add(a); });
  }
  const clusterNodes = selectedId ? nodes.filter(n => cluster.has(n.id)) : nodes;
  const degree = {};
  clusterNodes.forEach(n => { degree[n.id] = 0; });
  edges.forEach(([a,b]) => {
    if (cluster.size === 0 || (cluster.has(a) && cluster.has(b))) {
      if (degree[a] !== undefined) degree[a]++;
      if (degree[b] !== undefined) degree[b]++;
    }
  });
  // Find min/max per type within cluster
  const typeStats = {};
  clusterNodes.forEach(n => {
    if (!typeStats[n.type]) typeStats[n.type] = { min:Infinity, max:-Infinity };
    typeStats[n.type].min = Math.min(typeStats[n.type].min, degree[n.id] ?? 0);
    typeStats[n.type].max = Math.max(typeStats[n.type].max, degree[n.id] ?? 0);
  });
  const sizes = {};
  nodes.forEach(n => {
    if (!cluster.has(n.id) && selectedId) { sizes[n.id] = (baseRanges[n.type]?.min ?? 14); return; }
    const { min:rMin, max:rMax } = baseRanges[n.type] || { min:18, max:30 };
    const stats = typeStats[n.type] || { min:0, max:0 };
    const t = stats.max === stats.min ? 0.5 : ((degree[n.id]??0) - stats.min) / (stats.max - stats.min);
    // Selected node gets a boost
    const boost = n.id === selectedId ? 1.18 : 1;
    sizes[n.id] = Math.round((rMin + t*(rMax-rMin)) * boost);
  });
  return sizes;
}

const COLORS = {
  modality:  { fill:"#4ADE80", stroke:"#22A35A", text:"#06150C", chip:"#0F2A1A", chipBorder:"#4ADE80", chipText:"#86EFAC", typeLabel:"Therapy modality" },
  concept:   { fill:"#A78BFA", stroke:"#7C5CE0", text:"#16092E", chip:"#1F1438", chipBorder:"#A78BFA", chipText:"#D4C5FB", typeLabel:"Core concept" },
  challenge: { fill:"#FB923C", stroke:"#D8651A", text:"#2A0F02", chip:"#2E1A0C", chipBorder:"#FB923C", chipText:"#FDC596", typeLabel:"Life challenge" },
  skill:     { fill:"#60D4F2", stroke:"#2EA8C9", text:"#031A22", chip:"#0D2530", chipBorder:"#60D4F2", chipText:"#A9E8F7", typeLabel:"Skill / technique" },
};
// ── Dynamic node sizing by degree centrality ───────────────────────────────────
// Pre-computed at module load — counts how many edges touch each node,
// then maps that onto a radius range per type.
const DEGREE_RANGES = {
  modality:  { min:22, max:34 },
  concept:   { min:20, max:38 },
  challenge: { min:20, max:32 },
  skill:     { min:14, max:26 },
};

function computeNodeSizes(nodes, edges) {
  // Count degree for every node
  const degree = {};
  nodes.forEach(n => { degree[n.id] = 0; });
  edges.forEach(([a, b]) => {
    if (degree[a] !== undefined) degree[a]++;
    if (degree[b] !== undefined) degree[b]++;
  });

  // For each type, find the min/max degree so we can normalise within the type
  const typeStats = {};
  nodes.forEach(n => {
    if (!typeStats[n.type]) typeStats[n.type] = { min: Infinity, max: -Infinity };
    typeStats[n.type].min = Math.min(typeStats[n.type].min, degree[n.id]);
    typeStats[n.type].max = Math.max(typeStats[n.type].max, degree[n.id]);
  });

  const sizes = {};
  nodes.forEach(n => {
    const { min: rMin, max: rMax } = DEGREE_RANGES[n.type] || { min:18, max:30 };
    const { min: dMin, max: dMax } = typeStats[n.type];
    const t = dMax === dMin ? 0.5 : (degree[n.id] - dMin) / (dMax - dMin);
    sizes[n.id] = Math.round(rMin + t * (rMax - rMin));
  });
  return { sizes, degree };
}

// ── Practice walkthroughs ──────────────────────────────────────────────────────
const PRACTICES = {
  "mindfulness": {
    title: "A mindfulness pause",
    duration: "5–10 minutes",
    intro: "This is a simple practice you can do anywhere — at your desk, before a difficult conversation, or when you notice your mind has been elsewhere for a while. You don't need silence or a special posture. All you need is to be willing to notice what's already here.",
    steps: [
      {
        heading: "Arrive",
        body: "Let your body settle wherever you are. You don't need to sit up straight or close your eyes, though you can. Just let yourself stop moving for a moment.\n\nTake one breath that's slightly longer and slower than your normal breath. Not forced — just an invitation to arrive."
      },
      {
        heading: "Notice what's here",
        body: "Without trying to change anything, ask: what am I aware of right now?\n\nMaybe it's sounds — traffic, a fan, voices somewhere. Maybe it's physical sensations — the chair beneath you, the temperature of the air, a tightness somewhere in your body. Maybe it's the texture of your thoughts — busy, slow, looping, scattered.\n\nJust notice. You're not evaluating whether this is good or bad. You're simply observing."
      },
      {
        heading: "Follow a few breaths",
        body: "Bring your attention to where you can feel your breath most clearly. Maybe it's the rise and fall of your chest. Maybe it's the air moving at your nostrils. Maybe it's your belly expanding and contracting.\n\nFollow three to five breaths from beginning to end — the full arc of each inhale, the natural pause at the top, the complete exhale.\n\nWhen your mind wanders (it will), that's not failure. That's the moment of practice. Gently return."
      },
      {
        heading: "Open your attention",
        body: "Now let your attention widen — from the breath to the body as a whole, from the body to the room, from the room to whatever you can hear or sense beyond it.\n\nYou're not grasping for anything. You're just sitting inside your own awareness like you'd sit inside a quiet room."
      },
      {
        heading: "Before you return",
        body: "Before you move on to whatever's next, take a moment to notice how you feel now compared to when you started. Not to judge the practice — just to see.\n\nMindfulness doesn't require feeling calm. It only requires noticing what's true, right now. That's the whole practice."
      }
    ]
  },

  "body-scan": {
    title: "Body scan",
    duration: "10–20 minutes",
    intro: "A body scan is a practice of slowly moving your attention through the body — not to fix anything, but to feel what's actually there. Many of us spend most of our time in our heads. This is an invitation to come home to the rest of you.\n\nFind a position that's comfortable — lying down is traditional, but sitting is fine. Let your eyes close or rest on a soft point.",
    steps: [
      {
        heading: "Ground yourself first",
        body: "Before scanning, spend a moment feeling the contact points between your body and the surface beneath you. The back of your head, your shoulders, your lower back, the backs of your legs, your heels.\n\nLet yourself be held by whatever you're resting on. You don't have to hold yourself together right now."
      },
      {
        heading: "Begin at the feet",
        body: "Bring your attention to your feet — both of them. Not your idea of feet, but the actual felt sense. Do you notice warmth or coolness? Tingling? Pressure from socks or the floor? Maybe numbness, or very little sensation at all.\n\nNotice without needing it to be different. If you find tension, you can breathe into it gently — imagining the breath reaching all the way down — but you're not trying to relax. You're trying to feel."
      },
      {
        heading: "Move slowly upward",
        body: "Let your attention travel, slowly, up through your calves and shins. Into your knees. Up through your thighs — the front, the back, the inner and outer edges.\n\nSpend a breath or two in each region. Some areas will feel alive with sensation. Others will be quiet or numb. Both are fine. Numbness is information too.\n\nContinue into your hips, your pelvis, your lower back. This area holds a lot for many people — notice what's here without trying to fix it."
      },
      {
        heading: "The belly and chest",
        body: "Let your attention rest in your belly. Feel it rise and fall with each breath. Notice whether your breathing is shallow or full, easy or effortful.\n\nMove into your chest — feel your heartbeat if you can. Your ribcage expanding. Any tightness or openness here.\n\nThese are the regions most connected to emotion. If feelings arise — sadness, anxiety, relief — let them. They're not interruptions. They're part of what's here."
      },
      {
        heading: "Hands, arms, shoulders",
        body: "Bring your awareness to your hands. What do you feel in your palms? Your fingers? Any pulsing, tingling, warmth?\n\nTravel up through your forearms, elbows, upper arms. Into your shoulders — one of the most common places where people hold tension without knowing it.\n\nIf you find tightness here, you can exhale slowly and let the shoulders soften. Not force them down — just release what doesn't need to be held."
      },
      {
        heading: "Neck, face, and head",
        body: "Move into your neck — the back, the sides, the throat. Notice whether you're holding your head forward or are able to let it rest.\n\nBring attention to your face: your jaw (is it clenched?), your tongue (is it pressed to the roof of your mouth?), the muscles around your eyes, your forehead.\n\nMany people discover they've been holding their faces quite tightly. You can let the jaw drop slightly, let the tongue float, let the brow soften."
      },
      {
        heading: "The whole body at once",
        body: "Now let your attention expand to hold your whole body at once — as one complete, breathing thing. Not a collection of parts, but a single living presence.\n\nRest here for as long as feels right. Breathing. Noticing. Not needing anything to be other than it is.\n\nWhen you're ready to return, wiggle your fingers and toes first. Take a fuller breath. Open your eyes slowly. See if you can carry some of this quality of noticing with you into whatever comes next."
      }
    ]
  },

  "breathing": {
    title: "Box breathing",
    duration: "3–5 minutes",
    intro: "Box breathing is one of the most direct tools we have for shifting the nervous system from threat mode into safety. The pattern — equal counts in, hold, out, hold — works by activating the parasympathetic nervous system and giving the mind something rhythmic and structured to follow.\n\nIt's used by surgeons, Navy SEALs, and anyone who needs to think clearly under pressure. You can do this before a difficult conversation, during a moment of panic, or as a regular morning practice.",
    steps: [
      {
        heading: "Find your count",
        body: "Start by exhaling fully — releasing whatever's already in your lungs. Don't force it, just let it go.\n\nFor most people, a count of 4 is comfortable. If you're very anxious, start with 3. If you're a regular meditator, you might extend to 5 or 6. The count should feel like a gentle stretch, not a strain."
      },
      {
        heading: "Inhale — 4 counts",
        body: "Breathe in slowly through your nose for 4 counts: 1… 2… 3… 4.\n\nLet the breath fill from the bottom of your lungs first — belly expanding — then rising into the chest. Don't force a huge breath. Smooth and steady."
      },
      {
        heading: "Hold — 4 counts",
        body: "At the top of the inhale, hold gently for 4 counts: 1… 2… 3… 4.\n\nThis isn't a tense hold — you're not gripping the breath. Just pause, suspended. Notice the stillness here."
      },
      {
        heading: "Exhale — 4 counts",
        body: "Release through your mouth or nose for 4 slow counts: 1… 2… 3… 4.\n\nThe exhale activates the vagus nerve and the parasympathetic response. Make it smooth and complete. Let the belly soften."
      },
      {
        heading: "Hold — 4 counts",
        body: "At the bottom of the exhale, hold gently for 4 counts: 1… 2… 3… 4.\n\nThis is the quietest moment in the cycle. The lungs are empty. The body is between states. Rest here before the next breath begins."
      },
      {
        heading: "Repeat 4–6 cycles",
        body: "That's one complete box. Repeat for 4 to 6 cycles — or longer if it feels good.\n\nMost people notice a shift within 2 cycles: the heart rate begins to slow, the shoulders drop slightly, the thoughts quiet.\n\nIf you lose count, don't worry. Just return to the pattern. That gentle return — again and again — is itself the practice."
      }
    ]
  },

  "defusion": {
    title: "Leaves on a stream",
    duration: "5–10 minutes",
    intro: "This is the most well-known defusion exercise from ACT. Its purpose is to help you experience your thoughts as events passing through your mind — rather than facts about reality or commands you must obey.\n\nYou don't need to believe your thoughts are just thoughts for this to work. You just need to be willing to try seeing them that way for a few minutes.",
    steps: [
      {
        heading: "Settle in",
        body: "Close your eyes or let them rest on a soft point. Take two or three slow breaths to arrive in this moment.\n\nYou're going to spend a few minutes observing your own mind — watching what comes up without getting caught in it."
      },
      {
        heading: "Imagine a slow-moving stream",
        body: "Picture a gentle stream in your mind. The water moves slowly. Along the surface, autumn leaves float past — some large, some small, some close together, some with long gaps between them.\n\nYou are sitting on the bank, watching. You're not in the stream. You're not the leaves. You are the one watching from the shore."
      },
      {
        heading: "Place your thoughts on leaves",
        body: "As thoughts arise — and they will — place each one on a leaf and watch it float away downstream.\n\nIt doesn't matter what kind of thought it is. A memory: put it on a leaf. A worry: on a leaf. A plan for later: on a leaf. A judgment about whether you're doing this right: on a leaf.\n\nYou're not fighting the thoughts or trying to make them stop. You're simply noticing them and letting them pass."
      },
      {
        heading: "When you get pulled in",
        body: "You'll almost certainly find yourself caught up in a thought at some point — suddenly thinking about your to-do list, or replaying a conversation, or analyzing the exercise itself.\n\nThis is normal. It's what minds do.\n\nWhen you notice it's happened, gently say to yourself: 'I got caught in a thought.' Then return to the bank. Return to watching. Place the thought that caught you on a leaf too."
      },
      {
        heading: "Notice the space between thoughts",
        body: "As you continue, begin to notice the gaps — the moments between leaves where the stream surface is clear.\n\nThose gaps are always there. They are you, the observer, before any thought arises. Some people find this space peaceful. Some find it unsettling. Whatever you notice, that noticing is the point."
      },
      {
        heading: "Come back slowly",
        body: "After 5 to 10 minutes, let the image of the stream gently fade. Take a breath. Feel where your body is in space.\n\nAsk yourself: are there thoughts that feel less 'sticky' right now? Are there things you were fused with before that feel slightly more like just-thoughts?\n\nThat quality of distance — even a small amount — is defusion. It's available to you anytime you remember you are the bank, not the stream."
      }
    ]
  },

  "beh-activation": {
    title: "Behavioral activation — planning your first move",
    duration: "15–20 minutes (reflection + planning)",
    intro: "Behavioral activation is not about forcing yourself to feel motivated. It works on a simpler premise: action comes before feeling, not after. You don't wait until you feel like doing something — you do the thing, and the feeling often follows.\n\nThis walkthrough will help you identify one meaningful activity and build the smallest possible version of it.",
    steps: [
      {
        heading: "Notice the pattern",
        body: "When low mood or anxiety sets in, most of us naturally withdraw — we cancel plans, stay in bed longer, avoid the things we used to enjoy. This makes sense as a short-term response.\n\nBut withdrawal reduces the chances of positive experiences, which deepens the low mood, which leads to more withdrawal. It's a loop.\n\nTake a moment to notice: what have you been withdrawing from lately? What have you been doing less of?"
      },
      {
        heading: "Name what used to matter",
        body: "Think of activities — not achievements — that used to bring you a sense of pleasure, connection, or meaning. They don't have to be big.\n\nExamples: making coffee slowly in the morning. Texting a specific friend. Walking a particular route. Reading something you chose yourself. Cooking a real meal. Being near water. Playing music.\n\nWrite down two or three that come to mind. Don't filter for whether you 'feel like' them right now. Just name them."
      },
      {
        heading: "Choose one and shrink it",
        body: "Pick one activity from your list. Now make it smaller.\n\nNot 'go for a run' — 'put on shoes and walk to the end of the street.'\nNot 'call my friend' — 'send them one voice note.'\nNot 'cook dinner' — 'chop the vegetables.'\n\nThe goal is to reduce the activation energy to almost nothing. A five-minute version counts. A partial version counts. Starting and stopping counts.\n\nWhat's the smallest version of your activity that still has the essence of it?"
      },
      {
        heading: "Schedule it specifically",
        body: "Vague intentions don't become actions. Specific ones sometimes do.\n\nDecide: what day? What time? Where exactly? What will you do immediately before it that can serve as a cue?\n\nWrite it down somewhere you'll see it: 'On [day] at [time], after [existing habit], I will [specific small version of activity].'\n\nThis isn't a promise to feel better. It's an experiment."
      },
      {
        heading: "Track the connection — not the mood",
        body: "After you do the activity (or attempt it), notice:\n— What did I actually do?\n— What did I notice during it?\n— How did I feel before, during, and after?\n\nYou're not looking for transformation. You're looking for data. Even a small shift — a moment of ease, a brief sense of engagement — is meaningful.\n\nOver time, this tracking helps you see the connection between action and mood that depression and anxiety try to hide from you."
      },
      {
        heading: "Repeat and build",
        body: "One activity is enough to start. Do it a few times before adding another.\n\nAs momentum builds, you can expand the activity, add a second one, or begin structuring your week around a balance of:\n— Activities that give pleasure\n— Activities that give a sense of mastery or accomplishment\n— Activities that connect you to other people\n\nThe goal isn't a full schedule. It's enough contact with your own life that the loop begins to turn the other way."
      }
    ]
  }
};

// ── Distress tolerance practice ────────────────────────────────────────────────
PRACTICES["distress-tol"] = {
  title: "TIPP — Fast nervous system reset",
  duration: "5–20 minutes",
  intro: "TIPP is a DBT skill designed for moments when emotion is so intense it's hard to think clearly. It works directly on the body's physiology — not through insight or reasoning, but through four concrete actions that shift your nervous system state fast.\n\nUse this when you're in crisis, overwhelmed, or feel like you might do something you'll regret. It's not about solving the problem. It's about getting regulated enough to think.",
  steps: [
    {
      heading: "T — Temperature",
      body: "This is the fastest-acting tool in the kit. Cold water triggers the mammalian dive reflex, which immediately slows your heart rate and calms the nervous system.\n\nHow: Fill a bowl or sink with cold water (add ice if you have it). Take a breath, then submerge your face for 15–30 seconds. Or hold a bag of frozen vegetables to your cheeks and eyes.\n\nIf that's not available: step outside into cold air, drink ice water slowly, or hold ice cubes in your hands.\n\nYou should feel a shift within seconds. It's not subtle — this is biology, not belief."
    },
    {
      heading: "I — Intense exercise",
      body: "Intense emotion is the body preparing for action — fight or flight. Intense exercise lets it complete that response.\n\nHow: Do something vigorous for 15–20 minutes — run, jump, do push-ups until you can't, sprint up stairs. The goal is to get your heart rate up enough that it becomes hard to talk.\n\nThis metabolizes the stress hormones (cortisol, adrenaline) that are keeping you activated. Afterward, emotion intensity typically drops noticeably — not because the problem is solved, but because the body has discharged what it was holding.\n\nEven 5 minutes of high-intensity movement helps if 20 isn't available."
    },
    {
      heading: "P — Paced breathing",
      body: "When distressed, breathing becomes fast and shallow, which signals danger to the nervous system and amplifies the feeling of crisis. Slowing it down sends the opposite signal.\n\nHow: Breathe in for 4 counts, out for 6–8 counts. The key is making the exhale longer than the inhale — this activates the parasympathetic nervous system directly.\n\nDo this for at least 3–5 minutes. One or two breaths won't do it. Sustained slow breathing is what shifts the state.\n\nIf you find yourself hyperventilating, try breathing into cupped hands or a paper bag briefly to restore CO₂ balance."
    },
    {
      heading: "P — Paired muscle relaxation",
      body: "Emotional tension lives in the body as physical tension. This technique systematically releases it.\n\nHow: As you inhale, tense a muscle group firmly (not painfully) for 5–7 seconds. As you exhale slowly, release completely and notice the contrast.\n\nWork through: hands → forearms → upper arms → shoulders → face → chest → belly → legs → feet.\n\nThe key is the release — really letting go as you breathe out, rather than just stopping the tension. That contrast between tight and released is what down-regulates the nervous system.\n\nFull body takes about 10 minutes. If you only have time for one area, shoulders and jaw carry the most held tension for most people."
    },
    {
      heading: "After TIPP — check in",
      body: "Once you've used one or more TIPP skills, pause and notice: where is your emotion intensity now, on a 0–10 scale?\n\nIf it's come down even a few points — from an 8 to a 5, say — that's enough to start using other skills. You're now regulated enough to think about what you actually want to do.\n\nIf it's still very high, repeat a TIPP skill or try a different one. Some people need temperature and exercise together. Others find paced breathing alone is enough.\n\nRemember: TIPP changes your body state so that your wiser mind becomes accessible again. The problem may still be there. But now you can face it as yourself."
    }
  ]
};

const NODES = [
  {id:"cbt",    label:"CBT",           full:"Cognitive Behavioral Therapy",   type:"modality",  x:120,y:155,
   summary:"A structured, goal-oriented therapy focusing on the link between thoughts, feelings, and behaviors.",
   content:"CBT is based on the idea that negative thought cycles trap us in distress. By identifying and restructuring those patterns we change how we feel and act.\n\nCore tools: thought records, behavioral activation, cognitive restructuring, exposure hierarchies.",
   links:["thought-records","beh-activation","rumination","anxiety","low-mood"]},

  {id:"act",    label:"ACT",           full:"Acceptance & Commitment Therapy", type:"modality", x:120,y:270,
   summary:"A mindfulness-based therapy that teaches acceptance of painful thoughts rather than fighting them.",
   content:"ACT builds psychological flexibility through six processes: Acceptance, Cognitive Defusion, Present Moment, Self-as-Context, Values, and Committed Action.\n\nThe goal isn't to feel better — it's to live better even while feeling bad.",
   links:["defusion","values","mindfulness","rumination","self-worth"]},

  {id:"dbt",    label:"DBT",           full:"Dialectical Behavior Therapy",   type:"modality",  x:120,y:385,
   summary:"A skills-based therapy balancing acceptance and change, especially effective for emotional intensity.",
   content:"DBT teaches four skill modules: Mindfulness, Distress Tolerance, Emotional Regulation, and Interpersonal Effectiveness.\n\nThe core dialectic: you are doing the best you can AND you need to do better.",
   links:["distress-tol","emotion-reg","mindfulness","relationships","self-worth"]},

  {id:"ifs",    label:"IFS",           full:"Internal Family Systems",        type:"modality",  x:120,y:490,
   summary:"A model viewing the mind as made up of multiple parts — each with its own perspective and role.",
   content:"IFS proposes a core Self (wise, compassionate) surrounded by parts: Exiles carry old pain; Managers and Firefighters protect against it.\n\nHealing means helping parts unburden — not eliminating them.",
   links:["self-compassion","emotion-reg","self-worth","trauma"]},

  {id:"somatic",label:"Somatic",       full:"Somatic Experiencing",          type:"modality",   x:120,y:570,
   summary:"Body-oriented therapy that releases trauma held in the nervous system.",
   content:"Developed by Peter Levine, SE focuses on body sensation rather than narrative. Clients learn to track and discharge incomplete survival responses.\n\nFour core practices work together:\n\n• Fight, Flight, Freeze — understanding the body's automatic survival responses\n• Tracking Sensation — following the body's felt sense with curiosity\n• Titration — working with difficult material in small, safe doses\n• Pendulation — moving rhythmically between activation and ease\n\nExplore each below.",
   links:["grounding","mindfulness","trauma","anxiety"]},

  {id:"mindfulness",    label:"Mindfulness",      type:"concept", x:410,y:115,
   summary:"Intentionally attending to the present moment without judgment.",
   content:"The common thread across nearly every modern therapy. Mindfulness reduces rumination, stress reactivity, and emotional dysregulation.\n\nPractices range from formal sitting meditation to brief 'pause' moments throughout the day.",
   links:["body-scan","breathing","rumination","anxiety"]},

  {id:"defusion",       label:"Defusion",         type:"concept", x:345,y:225,
   summary:"Creating distance from unhelpful thoughts so they have less power over behavior.",
   content:"From ACT — instead of being fused with 'I'm worthless', defusion creates space: 'I notice I'm having the thought that I'm worthless.'\n\nTechniques: naming the story, singing the thought, thank-your-mind.",
   links:["mindfulness","thought-records","rumination"]},

  {id:"values",         label:"Values",            type:"concept", x:475,y:225,
   summary:"Chosen life directions that guide meaningful action even in the presence of pain.",
   content:"Values differ from goals — they are never finished, only lived. A compass heading, not a destination.\n\nCommon domains: family, health, creativity, contribution, friendship, spirituality.",
   links:["beh-activation","self-worth","relationships"]},

  {id:"self-compassion",label:"Self-compassion",   type:"concept", x:410,y:325,
   summary:"Treating yourself with the same kindness you'd offer a good friend who is suffering.",
   content:"Kristin Neff's three components: self-kindness (vs. judgment), common humanity (vs. isolation), mindfulness (vs. over-identification).\n\nMore effective than self-esteem for resilience — it doesn't require feeling special, just human.",
   links:["emotion-reg","self-worth","relationships"]},

  {id:"emotion-reg",    label:"Emotion regulation",type:"concept", x:340,y:425,
   summary:"Understanding and managing emotional responses rather than being overwhelmed by them.",
   content:"Emotion regulation includes identifying feelings, reducing vulnerability (sleep, food, exercise), and using opposite action.\n\nKey insight: we can't choose our first emotion, but we can influence what comes next.",
   links:["distress-tol","self-compassion","mindfulness"]},

  {id:"rumination",     label:"Rumination",        type:"concept", x:475,y:425,
   summary:"Repetitive, passive focus on distress — replaying problems without moving toward solutions.",
   content:"Rumination is one of the most common maintaining factors in depression and anxiety. It feels productive but is actually avoidance.\n\nBroken by: behavioral activation, defusion, and present-moment awareness.",
   links:["mindfulness","defusion","beh-activation"]},

  {id:"anxiety",      label:"Anxiety &\nnervousness",  type:"challenge", x:730,y:115,
   summary:"Persistent worry, physical tension, and avoidance that limits how freely you live.",
   content:"Anxiety is the mind's alarm system — protective in genuine danger, but often misfiring.\n\nKey maintaining factor: avoidance. What we avoid, we stay afraid of.\n\nEntry points: breathing to calm the nervous system, grounding to return to now, CBT to examine worry thoughts, ACT to unhook from them.",
   links:["breathing","grounding","mindfulness","cbt","act","defusion"]},

  {id:"social",       label:"Social\ndifficulty",      type:"challenge", x:775,y:230,
   summary:"Discomfort, self-consciousness, or avoidance in conversations and social situations.",
   content:"Social difficulty ranges from shyness to social anxiety disorder. Often maintained by self-focused attention and avoidance.\n\nHelpful moves: shifting attention outward, behavioral experiments, self-compassion for perceived mistakes.",
   links:["self-compassion","defusion","beh-activation","cbt","values"]},

  {id:"low-mood",     label:"Low mood &\ndepression",   type:"challenge", x:720,y:340,
   summary:"Persistent sadness, low energy, and loss of pleasure that dims daily life.",
   content:"Depression narrows the world — withdrawal reduces positive experiences, which deepens depression.\n\nBehavioral activation breaks the cycle. Values help re-engage with what matters. Self-compassion counters the harsh inner critic.",
   links:["beh-activation","values","self-compassion","mindfulness","rumination"]},

  {id:"relationships",label:"Relationships\n& romance",  type:"challenge", x:790,y:450,
   summary:"Patterns in intimacy, conflict, and connection — including fear of abandonment or repeated cycles.",
   content:"Relationship struggles often replay attachment patterns developed early in life.\n\nIFS helps understand the parts activated in conflict. DBT's interpersonal effectiveness skills build communication. Values clarification reveals what kind of partner/friend you want to be.",
   links:["values","self-compassion","emotion-reg","dbt","ifs"]},

  {id:"trauma",       label:"Trauma &\noverwhelm",       type:"challenge", x:685,y:550,
   summary:"The lasting impact of overwhelming experiences that the nervous system couldn't fully process.",
   content:"Trauma lives in the body as unfinished survival responses. It isn't a character flaw — it's an adaptive response to an impossible situation.\n\nSomatic approaches work with the body's memory. IFS helps care for parts that carry the burden.",
   links:["grounding","somatic","ifs","mindfulness","breathing"]},

  {id:"self-worth",   label:"Self-worth\n& identity",    type:"challenge", x:740,y:455,
   summary:"Struggles with feeling fundamentally okay, lovable, or capable.",
   content:"Low self-worth often shows up as people-pleasing, perfectionism, or difficulty accepting care.\n\nIFS helps identify the critical 'manager' parts. ACT defuses from the inner critic. Self-compassion offers an alternative to the pursuit of self-esteem.",
   links:["self-compassion","defusion","values","ifs","act"]},

  {id:"breathing",      label:"Box breathing",     type:"skill", x:570,y:115,
   summary:"Inhale 4 counts, hold 4, exhale 4, hold 4. Direct activation of the parasympathetic nervous system.",
   content:"Used by Navy SEALs and therapists alike. The extended hold and exhale directly signal safety to the nervous system.\n\nEven two cycles produces a measurable reduction in cortisol and heart rate.",
   links:[]},

  {id:"grounding",      label:"Grounding",          type:"skill", x:545,y:530,
   summary:"Techniques that anchor you to the present when dissociation or overwhelm pulls you away.",
   content:"5-4-3-2-1 (five senses), cold water on the face, feet on the floor. Routes attention from the threat-processing amygdala to sensory cortex.\n\nEspecially useful in trauma responses and panic.",
   links:["breathing"]},

  {id:"thought-records",label:"Thought records",    type:"skill", x:238,y:160,
   summary:"Structured practice to examine and reframe automatic unhelpful thoughts.",
   content:"Identify situation → notice automatic thought → name the distortion → generate balanced response → rate mood shift.\n\nCommon distortions: catastrophizing, black-and-white thinking, mind reading, fortune telling.",
   links:[]},

  {id:"beh-activation", label:"Behavioral\nactivation", type:"skill", x:248,y:510,
   summary:"Scheduling meaningful and enjoyable activities to break the withdrawal cycle of low mood.",
   content:"The behavior comes first — mood follows action, not the other way around.\n\nStart small: a five-minute walk counts. Track the connection between activity and mood.",
   links:[]},

  {id:"distress-tol",   label:"Distress\ntolerance", type:"skill", x:238,y:400,
   summary:"Surviving a crisis without making things worse — accepting the moment as it is.",
   content:"From DBT — TIPP (Temperature, Intense exercise, Paced breathing, Paired muscle relaxation), ACCEPTS, radical acceptance.\n\nNot about solving the problem. About getting through it intact.",
   links:["breathing","grounding","anxiety","social","low-mood","relationships","trauma","self-worth"]},

  {id:"body-scan",      label:"Body scan",           type:"skill", x:555,y:315,
   summary:"Systematically moving attention through the body, noticing sensation without judgment.",
   content:"Builds interoceptive awareness — often disrupted by trauma and chronic stress.\n\nUsed in MBSR, somatic therapy, and sleep protocols. Can be done in 5 minutes or 45.",
   links:[]},
];

// ── Canvas bounds, derived from actual node positions ──────────────────────
// Padding is generous on every side so there's room to pan beyond the
// outermost nodes, plus headroom for future nodes added further out without
// needing to touch this padding amount. Recompute this any time NODES grows —
// it's a pure function of the data, not a hand-tuned constant.
const CANVAS_PAD = 600;
function computeCanvasBounds(nodes) {
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  const minX = Math.min(...xs) - CANVAS_PAD, maxX = Math.max(...xs) + CANVAS_PAD;
  const minY = Math.min(...ys) - CANVAS_PAD, maxY = Math.max(...ys) + CANVAS_PAD;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
const CANVAS_BOUNDS = computeCanvasBounds(NODES);

// ── Scattered background star field for the Starry Night theme ────────────────
// Deterministic (not random) so the field doesn't reshuffle on every re-render.
// Density (stars per unit area) is held constant rather than star *count*, so
// the field automatically gets denser-looking coverage as CANVAS_BOUNDS grows
// with more/wider-spread nodes, instead of the same 140 stars stretching thin
// over a much bigger area.
const STAR_DENSITY_PER_1000PX2 = 0.0617; // = 140 stars / (1800×1260px / 1000) — matches the original look exactly
const BACKGROUND_STAR_COUNT = Math.round(
  (CANVAS_BOUNDS.width * CANVAS_BOUNDS.height / 1000) * STAR_DENSITY_PER_1000PX2
);
const BACKGROUND_STARS = Array.from({ length: BACKGROUND_STAR_COUNT }, (_, i) => ({
  x: CANVAS_BOUNDS.x + ((i * 137.3) % CANVAS_BOUNDS.width),
  y: CANVAS_BOUNDS.y + ((i * 91.7) % CANVAS_BOUNDS.height),
  r: 0.5 + (i % 5) * 0.3,
  delay: (i % 9) * 0.35,
}));

const EDGES = [
  ["cbt","thought-records"],["cbt","beh-activation"],["cbt","rumination"],["cbt","anxiety"],["cbt","low-mood"],
  ["act","defusion"],["act","values"],["act","mindfulness"],["act","rumination"],["act","self-worth"],
  ["dbt","distress-tol"],["dbt","emotion-reg"],["dbt","mindfulness"],["dbt","relationships"],["dbt","self-worth"],
  ["ifs","self-compassion"],["ifs","emotion-reg"],["ifs","self-worth"],["ifs","trauma"],["ifs","relationships"],
  ["somatic","grounding"],["somatic","mindfulness"],["somatic","trauma"],["somatic","anxiety"],
  ["mindfulness","body-scan"],["mindfulness","breathing"],["mindfulness","rumination"],["mindfulness","anxiety"],
  ["defusion","mindfulness"],["defusion","thought-records"],["defusion","rumination"],
  ["values","beh-activation"],["values","self-worth"],["values","relationships"],
  ["self-compassion","emotion-reg"],["self-compassion","self-worth"],["self-compassion","relationships"],
  ["emotion-reg","distress-tol"],["emotion-reg","mindfulness"],
  ["rumination","mindfulness"],["rumination","defusion"],["rumination","beh-activation"],
  ["anxiety","breathing"],["anxiety","grounding"],["anxiety","mindfulness"],["anxiety","defusion"],
  ["social","self-compassion"],["social","defusion"],["social","beh-activation"],["social","values"],
  ["low-mood","beh-activation"],["low-mood","values"],["low-mood","self-compassion"],["low-mood","rumination"],
  ["relationships","values"],["relationships","self-compassion"],["relationships","emotion-reg"],
  ["trauma","grounding"],["trauma","mindfulness"],["trauma","breathing"],
  ["self-worth","self-compassion"],["self-worth","defusion"],["self-worth","values"],
  ["distress-tol","breathing"],["distress-tol","grounding"],
  ["distress-tol","anxiety"],["distress-tol","social"],["distress-tol","low-mood"],
  ["distress-tol","relationships"],["distress-tol","trauma"],["distress-tol","self-worth"],
  ["grounding","breathing"],
];

const LEGEND = [
  {type:"modality",  label:"Therapy modality"},
  {type:"concept",   label:"Core concept"},
  {type:"challenge", label:"Life challenge"},
  {type:"skill",     label:"Skill / technique"},
];

function nodeById(id){ return NODES.find(n=>n.id===id); }
function connectedSet(id){
  const s=new Set([id]);
  EDGES.forEach(([a,b])=>{ if(a===id)s.add(b); if(b===id)s.add(a); });
  return s;
}

// ── History data ───────────────────────────────────────────────────────────────
const HISTORY = {
  cbt: {
    era: "1960s – present",
    origin: "Philadelphia, USA",
    founders: ["Aaron Beck", "Albert Ellis"],
    narrative: "CBT grew out of a quiet rebellion against psychoanalysis. Aaron Beck, a psychiatrist at the University of Pennsylvania, noticed that his depressed patients shared a pattern of automatic negative thoughts — and that addressing those thoughts directly produced faster results than years of free association. Albert Ellis had reached a similar conclusion independently, developing Rational Emotive Behavior Therapy in the 1950s. The two streams merged into what became the most researched psychotherapy in history.",
    milestones: [
      { year: "1955", event: "Albert Ellis develops Rational Emotive Therapy, one of CBT's earliest precursors" },
      { year: "1960s", event: "Aaron Beck begins systematically studying depressive thinking at UPenn, identifying cognitive distortions" },
      { year: "1979", event: "Beck publishes Cognitive Therapy of Depression — the text that launches modern CBT" },
      { year: "1980s", event: "CBT expands beyond depression into anxiety, PTSD, eating disorders, and chronic pain" },
      { year: "1990s–2000s", event: "Becomes the dominant evidence-based therapy in clinical trials globally; adopted by national health systems including the UK's NHS" },
      { year: "Today", event: "Over 2,000 randomized controlled trials support its efficacy; forms the backbone of most structured therapy training worldwide" },
    ],
    context: "CBT emerged during a period when psychology was torn between Freudian depth psychology and behaviorism. Beck's genius was synthesizing both — taking the behaviorists' emphasis on measurable change and the analysts' interest in inner life, and creating a practical, teachable bridge between them."
  },

  act: {
    era: "1980s – present",
    origin: "Reno, Nevada, USA",
    founders: ["Steven C. Hayes"],
    narrative: "ACT was born from Steven Hayes's own panic disorder — and from his frustration that standard behavioral techniques weren't working for him or many of his clients. Beginning in the early 1980s, Hayes and colleagues developed Relational Frame Theory (RFT), a behavioral account of human language and cognition. ACT emerged as its clinical application: if language is what traps us in suffering, then changing our relationship to language — rather than fighting its content — is the path through.",
    milestones: [
      { year: "1982", event: "Hayes begins developing the theoretical foundations that will become Relational Frame Theory" },
      { year: "1986", event: "First ACT manual circulated privately among researchers and clinicians" },
      { year: "1999", event: "Hayes, Strosahl & Wilson publish Acceptance and Commitment Therapy — the definitive founding text" },
      { year: "2000s", event: "ACT research explodes; shown effective for depression, anxiety, chronic pain, substance use, and psychosis" },
      { year: "2004", event: "The Association for Contextual Behavioral Science (ACBS) founded, creating a global ACT community" },
      { year: "Today", event: "Over 500 randomized trials; widely used in military, medical, and organizational settings beyond clinical psychology" },
    ],
    context: "ACT is part of what Hayes called the 'third wave' of behavior therapy — moving beyond first-wave conditioning and second-wave cognitive restructuring into a focus on psychological flexibility and values-based living. Its roots in Buddhist philosophy are acknowledged, though it presents as a secular, empirically-grounded model."
  },

  dbt: {
    era: "1980s – present",
    origin: "Seattle, Washington, USA",
    founders: ["Marsha M. Linehan"],
    narrative: "DBT has one of the most personal origin stories in modern psychotherapy. Marsha Linehan, who would later disclose her own history of severe emotional dysregulation and hospitalization, developed DBT after finding that pure CBT was too focused on change — and invalidated the very real pain of the clients she was trying to help. The 'dialectic' at the heart of DBT — acceptance and change held simultaneously — came from Linehan's own struggle to reconcile those poles.",
    milestones: [
      { year: "1970s", event: "Linehan begins working with chronically suicidal patients and finds CBT insufficient alone" },
      { year: "1980", event: "Linehan incorporates Zen mindfulness principles into a behavioral framework, creating DBT's philosophical core" },
      { year: "1991", event: "Landmark randomized trial published: DBT reduces suicide attempts and self-harm in borderline personality disorder more than treatment-as-usual" },
      { year: "1993", event: "Linehan publishes the DBT Skills Training Manual — still the standard clinical reference today" },
      { year: "2000s", event: "DBT adapted for adolescents, eating disorders, substance use, and families" },
      { year: "2011", event: "Linehan publicly discloses her own diagnosis, reshaping public understanding of lived experience in therapy development" },
      { year: "Today", event: "Standard of care for borderline personality disorder; one of the most structured and manualized therapies in clinical practice" },
    ],
    context: "DBT was the first therapy specifically designed for people who felt that other therapies were asking them to change before they felt understood. Its explicit validation strategies — naming that a person's responses make sense given their history — were revolutionary in an era when therapists were trained to remain neutral."
  },

  ifs: {
    era: "1980s – present",
    origin: "Chicago, Illinois, USA",
    founders: ["Richard C. Schwartz"],
    narrative: "IFS began as an accident of listening. Richard Schwartz, a family therapist in the 1980s, kept hearing his clients describe their inner worlds in terms of parts — 'part of me wants to leave, part of me is terrified to'. Rather than treating this as metaphor, Schwartz began engaging these parts directly. What emerged was a coherent model: the mind as a system of sub-personalities organized around a core Self, which is always present and always capable of healing.",
    milestones: [
      { year: "1980s", event: "Schwartz, trained as a structural family therapist, begins adapting family systems thinking to internal psychological structure" },
      { year: "Early 1990s", event: "IFS model takes shape through clinical observation; Schwartz identifies the roles of Exiles, Managers, and Firefighters" },
      { year: "1995", event: "Internal Family Systems Therapy published — the founding text of the model" },
      { year: "2000s", event: "IFS gains traction in trauma treatment; integration with somatic approaches deepens" },
      { year: "2015", event: "Frank Anderson and others begin publishing on IFS and neuroscience, bridging the model with attachment theory" },
      { year: "2021", event: "IFS listed as an evidence-based practice in SAMHSA's National Registry; research base grows substantially" },
      { year: "Today", event: "Widely used for trauma, eating disorders, anxiety, and relational difficulties; increasingly influential in coaching and leadership contexts" },
    ],
    context: "IFS is unusual in its insistence that no part is inherently bad — only burdened. This non-pathologizing stance, combined with the idea of an undamaged core Self, gives the model a fundamentally hopeful architecture that distinguishes it from approaches focused on symptom reduction."
  },

  somatic: {
    era: "1970s – present",
    origin: "Berkeley, California, USA",
    founders: ["Peter A. Levine"],
    narrative: "Peter Levine's insight came from watching animals. Animals in the wild experience life-threatening danger constantly — and then shake it off, literally, and return to grazing. Humans, Levine observed, rarely complete this biological discharge cycle. The trauma stays lodged in the nervous system as incomplete survival responses. Somatic Experiencing was built around one question: what if healing trauma means finishing, rather than reliving, what the body started?",
    milestones: [
      { year: "1970s", event: "Levine, trained in biophysics and psychology, begins observing stress responses in animals and humans" },
      { year: "1977", event: "Levine treats a woman with severe trauma-related physical symptoms using body-focused methods — a founding clinical experience he later writes about extensively" },
      { year: "1997", event: "Waking the Tiger: Healing Trauma published — introduces SE to a general audience and becomes a foundational trauma text" },
      { year: "2000s", event: "SE training programs established internationally; integration with EMDR, IFS, and attachment theory develops" },
      { year: "2010", event: "In an Unspoken Voice: How the Body Releases Trauma published — Levine's most clinically detailed work" },
      { year: "Today", event: "SE practiced in over 45 countries; particularly influential in complex trauma, developmental trauma, and medical trauma treatment" },
    ],
    context: "Somatic Experiencing emerged alongside Wilhelm Reich's body-centered work and influenced, and was influenced by, thinkers like Eugene Gendlin (Focusing) and Bessel van der Kolk (whose The Body Keeps the Score later popularized somatic approaches for mainstream audiences). It sits at the intersection of neuroscience, evolutionary biology, and clinical practice."
  },
};

// ── Tips data — practical "how to apply this" guidance for concepts & skills ──
const TIPS = {
  mindfulness: {
    intro: "Mindfulness is easy to understand and surprisingly easy to do wrong — most people either force stillness or give up after a few seconds of a wandering mind. These tips are about making it sustainable.",
    tips: [
      { title: "Anchor it to something you already do", body: "Don't rely on remembering to practice. Attach it to an existing habit — the first sip of coffee, waiting for a page to load, brushing your teeth. The habit becomes the cue." },
      { title: "Mind-wandering is the practice, not a failure of it", body: "Every time you notice you've drifted and come back, that's a successful rep — like a bicep curl. The 'failure' framing is what makes people quit." },
      { title: "Shrink it on hard days", body: "On days when sitting still feels impossible, do 30 seconds instead of 10 minutes. Consistency at a small dose beats sporadic effort at a large one." },
      { title: "Try it with eyes open sometimes", body: "Closed eyes work for some people and feel claustrophobic for others. A soft, unfocused gaze on a fixed point works just as well and feels more accessible in public." },
    ],
  },

  defusion: {
    intro: "Defusion can feel like a parlor trick the first few times — like you're just relabeling a thought rather than changing anything. The shift tends to show up after repeated use, not the first try.",
    tips: [
      { title: "Use it on small thoughts first", body: "Don't start with your most painful belief. Practice on mundane thoughts — \"I should clean my desk\" — so the technique feels natural before you bring it to something that matters." },
      { title: "Say it out loud once", body: "\"I'm having the thought that I'm going to fail this\" sounds different out loud than in your head. The verbal distance often makes the mental distance click faster." },
      { title: "Pair it with a physical gesture", body: "Some people find it helps to mentally 'place' the thought somewhere — on a cloud, a leaf, a passing train. A consistent visual anchor speeds up the skill over time." },
      { title: "Don't try to make the thought go away", body: "Defusion isn't about eliminating thoughts — it's about changing your relationship to them. If you're trying to make it disappear, you've slipped back into fighting it." },
    ],
  },

  values: {
    intro: "Values work tends to go wrong in one of two ways: people list what they think they *should* value, or they confuse values with goals. These tips help keep it honest and usable.",
    tips: [
      { title: "Notice when you feel most 'yourself'", body: "Rather than brainstorming values abstractly, think of moments you felt fully present and engaged. The value is usually hiding in what you were doing." },
      { title: "Separate the value from the outcome", body: "\"Being a present parent\" is a value you can act on today. \"Raising successful kids\" is an outcome you can't control. If a value depends on a result, look one layer underneath it." },
      { title: "Pick one value and one tiny action this week", body: "Values work becomes abstract fast. Anchor it by choosing a single small, concrete action this week that expresses one value — even a five-minute one." },
      { title: "Expect some values to conflict", body: "Ambition and rest are both legitimate values that will sometimes pull in opposite directions. That tension isn't a sign you're doing it wrong — it's normal and worth naming." },
    ],
  },

  "self-compassion": {
    intro: "Self-compassion is often confused with self-pity or letting yourself off the hook. In practice, it tends to make people more accountable, not less — these tips help it land that way.",
    tips: [
      { title: "Talk to yourself like a good coach, not a cheerleader", body: "Self-compassion isn't empty positivity. A good coach is warm but honest: \"That didn't go well, and you're still capable.\" That tone is more sustainable than forced positivity." },
      { title: "Use the friend test", body: "Ask: what would I say to a close friend in this exact situation? Most people are far kinder to others than themselves — closing that gap is the whole practice." },
      { title: "Notice common humanity in the moment, not after", body: "When you're struggling, try the thought \"this is a moment of difficulty, and difficulty is part of being human\" right then — not as a retrospective lesson once it's over." },
      { title: "Physical touch can help it land", body: "A hand on your chest or your own arms wrapped around you sounds strange but has real physiological calming effects — it can make the words feel less abstract." },
    ],
  },

  "emotion-reg": {
    intro: "Emotion regulation isn't about controlling or suppressing feelings — it's about widening the gap between feeling something and acting on it. These tips focus on that gap.",
    tips: [
      { title: "Name it specifically", body: "\"I feel bad\" gives you nothing to work with. \"I feel disappointed and a little embarrassed\" gives your brain something specific enough to actually process." },
      { title: "Check the facts before the feeling", body: "Ask: is this emotion matched to what's actually happening, or is it bigger than the situation calls for? Both answers are useful information, not a verdict." },
      { title: "Reduce vulnerability factors proactively", body: "Sleep, hunger, and isolation don't cause emotions but they turn up the volume on all of them. If you're regularly overwhelmed, check these basics before assuming it's the situation." },
      { title: "Opposite action, small dose", body: "If anxiety says avoid, try doing a tiny version of the opposite — approach in some small way. You don't need the full opposite action, just enough to interrupt the pattern." },
    ],
  },

  rumination: {
    intro: "Rumination feels like problem-solving, which is exactly why it's hard to stop — it's disguised as something useful. These tips target that disguise directly.",
    tips: [
      { title: "Set a 'worry appointment'", body: "Instead of trying to never think about it, schedule 10 minutes later to think about it on purpose. This sounds counterintuitive but reliably reduces intrusive looping." },
      { title: "Ask: is this generating any new information?", body: "Real problem-solving produces new insight or a next step. If you've had the same thought five times with no new conclusion, it's rumination, not problem-solving." },
      { title: "Change your physical position", body: "Rumination often happens in the same posture — lying down, slouched at a desk. Standing up, walking, or even just changing rooms can interrupt the loop more effectively than trying to think your way out." },
      { title: "Externalize it", body: "Write the looping thought down on paper. Something about getting it out of your head and onto a page tends to loosen its grip, even without resolving it." },
    ],
  },

  breathing: {
    intro: "Box breathing is simple, but small adjustments make a big difference in how effective it feels — these are the tweaks that matter most.",
    tips: [
      { title: "Exhale longer than you inhale if anxious", body: "If standard 4-4-4-4 doesn't calm you fast enough, try 4 in, 4 hold, 6-8 out. A longer exhale activates the calming vagus nerve more strongly than equal counts." },
      { title: "Do it before you need it, not just during crisis", body: "Practicing daily — even when calm — builds the skill so it actually works under real stress. It's much harder to learn a new skill in the middle of a panic spike." },
      { title: "Use your hand as a visual guide", body: "Trace a square shape in the air or on a surface with your finger as you breathe — visual and physical anchors help when your mind is too activated to just count silently." },
      { title: "Don't worry about perfect counts", body: "If 4 seconds feels too long or too short, adjust it. The mechanism (slow, controlled, rhythmic breath) matters more than hitting an exact number." },
    ],
  },

  grounding: {
    intro: "Grounding works by engaging the senses, but not every technique works for every person — these tips help you find what actually pulls you back to the present.",
    tips: [
      { title: "Test multiple senses, not just sight", body: "5-4-3-2-1 leads with sight, but some people ground faster through touch (textures) or sound (naming distinct noises). If one isn't working, try leading with a different sense." },
      { title: "Cold works fast when you need speed", body: "Ice water on the wrists, a cold drink, or stepping outside in cold air can ground you in seconds when slower techniques feel too gradual." },
      { title: "Name out loud, not just in your head", body: "Saying \"I see a red mug, I see a window\" out loud (even quietly) tends to anchor faster than doing it silently — it engages another part of the brain." },
      { title: "Practice when calm so it's automatic when not", body: "Like any skill, grounding works better in a real crisis if you've rehearsed it when you're not in crisis. Five minutes of practice on an ordinary day builds the pathway." },
    ],
  },

  "thought-records": {
    intro: "Thought records can feel clinical and slow at first — these tips are about making them faster and more natural over time.",
    tips: [
      { title: "Start with the emotion, not the thought", body: "It's often easier to notice \"I feel anxious\" first, then work backward to \"what was I just thinking?\" rather than trying to catch the thought directly." },
      { title: "Look for the distortion family, not the exact label", body: "You don't need to perfectly identify if it's 'catastrophizing' versus 'fortune telling' — just noticing it's an extreme prediction is enough to loosen its grip." },
      { title: "Write the balanced thought as a question, not a fact", body: "Instead of forcing yourself to believe \"everything will be fine,\" try \"what's actually likely to happen, based on past evidence?\" Questions feel less like lying to yourself." },
      { title: "Do it within a few hours, not days later", body: "The closer to the moment you record it, the more accurate and useful the thought record is. Memory reconstructs and softens detail quickly." },
    ],
  },

  "beh-activation": {
    intro: "Behavioral activation fails most often when the first step is too big. These tips are about making it nearly impossible to fail at starting.",
    tips: [
      { title: "Make the first version embarrassingly small", body: "If \"go for a run\" feels impossible, the goal is \"put on running shoes.\" You can always do more once you've started — starting is the only hard part." },
      { title: "Schedule it like an appointment", body: "Vague intentions (\"sometime today\") rarely happen. A specific time, even a rough one, dramatically increases follow-through." },
      { title: "Don't wait to feel motivated", body: "Motivation tends to follow action, not precede it. Waiting to feel ready is often just another form of avoidance dressed up as patience." },
      { title: "Track the activity, not the mood", body: "Mood is unreliable day to day. Tracking whether you did the activity gives you a cleaner signal of progress than tracking how you felt about it." },
    ],
  },

  "distress-tol": {
    intro: "Distress tolerance skills are built for crisis moments, which means they need to be familiar before the crisis hits. These tips are about pre-loading the skill.",
    tips: [
      { title: "Pick your go-to skill in advance", body: "Decide now, while calm, which TIPP skill you'll reach for first in a crisis. Decision-making is much harder mid-crisis — pre-deciding removes a step." },
      { title: "Keep tools physically accessible", body: "If cold water is your fastest reset, know where the nearest sink or freezer is. If you wait until you need it to find supplies, you lose precious time." },
      { title: "Use it to get through, not to fix", body: "Distress tolerance skills aren't meant to solve the underlying problem — they're meant to get your nervous system regulated enough to think. Don't judge them by whether the problem disappeared." },
      { title: "Combine skills if one isn't enough", body: "Cold water plus paced breathing often works faster than either alone. Don't feel locked into using just one TIPP component at a time." },
    ],
  },

  "body-scan": {
    intro: "Body scans can feel boring or pointless at first, especially if you're someone who's used to staying in your head. These tips help it become more textured over time.",
    tips: [
      { title: "Numbness is data, not failure", body: "If you can't feel a body part clearly, that's useful information — many people discover entire regions they've been disconnected from for years. Note it and move on, no need to force sensation." },
      { title: "Slow down more than feels necessary", body: "Most people rush body scans the first few times. Spending what feels like 'too long' on each region is usually closer to the right pace." },
      { title: "Try it lying down once, sitting once", body: "Body position changes what you notice. Lying down tends to reveal more subtle sensations; sitting can be more practical for daily use." },
      { title: "Use it as a check-in, not just a full ritual", body: "A 90-second partial scan — just shoulders, jaw, and belly — is a legitimate practice on its own, not just a shortened version of the 'real' thing." },
    ],
  },
};

// ── Tips panel ─────────────────────────────────────────────────────────────────
function TipsPanel({ nodeId }) {
  const t = TIPS[nodeId];
  if (!t) return (
    <div style={{paddingTop:32,textAlign:"center"}}>
      <p style={{color:"#475569",fontSize:13,lineHeight:1.7}}>No tips curated yet for this concept.</p>
    </div>
  );
  return (
    <div>
      <p style={{fontSize:13.5, lineHeight:1.75, color:"#94a3b8", marginBottom:20}}>{t.intro}</p>
      {t.tips.map((tip, i) => (
        <div key={i} style={{
          display:"flex", gap:12, marginBottom:14,
          background:"#060812", border:"1px solid #1C2040", borderRadius:8,
          padding:"12px 14px",
        }}>
          <div style={{
            flexShrink:0, width:22, height:22, borderRadius:"50%",
            background:"#F0B42922", border:"1px solid #F0B429",
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:11, fontWeight:700, color:"#F0B429",
          }}>{i+1}</div>
          <div>
            <p style={{fontSize:13.5, fontWeight:600, color:"#e2e8f0", margin:"0 0 4px", lineHeight:1.3}}>{tip.title}</p>
            <p style={{fontSize:13, lineHeight:1.7, color:"#94a3b8", margin:0}}>{tip.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}


const LINKS = {
  cbt: {
    plainSummary: "CBT is the most studied therapy in the world, so the hardest part isn't finding information — it's knowing where to start. These resources move from accessible overviews to the academic evidence base, so you can go as deep as you want.",
    keyResources: [
      { title: "What is Cognitive Behavioral Therapy?", source: "American Psychological Association", level: "Beginner", year: "2017", url: "https://www.apa.org/ptsd-guideline/patients-and-families/cognitive-behavioral", note: "Plain-language overview of what CBT is and how sessions typically work." },
      { title: "Find a CBT Therapist", source: "Association for Behavioral and Cognitive Therapies", level: "Beginner", year: "2024", url: "https://www.findcbt.org/FAT/", note: "Searchable directory of certified CBT practitioners by location." },
      { title: "CBT Self-Help Resources", source: "Centre for Clinical Interventions (Australia)", level: "Intermediate", year: "2023", url: "https://www.cci.health.wa.gov.au/Resources/Looking-After-Yourself", note: "Free, clinician-designed worksheets and modules covering anxiety, depression, and more." },
    ],
    research: [
      { title: "The Empirical Status of Cognitive-Behavioral Therapy: A Review of Meta-analyses", source: "Clinical Psychology Review", level: "Academic", year: "2006", authors: "Butler, Chapman, Forman & Beck", url: "https://doi.org/10.1016/j.cpr.2005.07.003", summary: "A landmark review synthesizing decades of meta-analytic data; established CBT's broad efficacy across disorders." },
      { title: "Cognitive Therapy of Depression", source: "Guilford Press (book)", level: "Academic", year: "1979", authors: "Beck, Rush, Shaw & Emery", url: "https://www.guilford.com/books/Cognitive-Therapy-of-Depression/Beck-Rush-Shaw-Emery/9780898629194", summary: "The original clinical text that launched modern CBT — foundational reading for clinicians." },
      { title: "Is Cognitive Behavior Therapy Falling Behind?", source: "Journal of Anxiety Disorders (open access)", level: "Academic", year: "2021", authors: "David, Cristea & Hofmann", url: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8185453/", summary: "A more recent, balanced look at CBT's evidence base relative to newer third-wave therapies." },
    ],
  },

  act: {
    plainSummary: "ACT's research base has grown quickly over the last two decades. Start with the official ACBS resources if you want a practitioner or self-help tools, then move into the studies that established psychological flexibility as a measurable, trainable skill.",
    keyResources: [
      { title: "What is ACT?", source: "Association for Contextual Behavioral Science", level: "Beginner", year: "2024", url: "https://contextualscience.org/act", note: "The official home of ACT — clear explanations of the six core processes." },
      { title: "Find an ACT Therapist", source: "ACBS Practitioner Directory", level: "Beginner", year: "2024", url: "https://contextualscience.org/civicrm/profile?gid=17&reset=1", note: "Global directory of ACT-trained clinicians." },
      { title: "Get Out of Your Mind and Into Your Life", source: "Steven Hayes (book)", level: "Intermediate", year: "2005", url: "https://www.newharbinger.com/9781572244252/get-out-of-your-mind-and-into-your-life/", note: "The most accessible self-help introduction to ACT, written by its founder." },
    ],
    research: [
      { title: "Acceptance and Commitment Therapy: Model, Processes and Outcomes", source: "Behaviour Research and Therapy", level: "Academic", year: "2006", authors: "Hayes, Luoma, Bond, Masuda & Lillis", url: "https://doi.org/10.1016/j.brat.2005.06.006", summary: "The defining theoretical paper laying out ACT's six core processes and evidence to date." },
      { title: "The Empirical Status of Acceptance and Commitment Therapy: A Review of Meta-Analyses", source: "Journal of Contextual Behavioral Science (open access)", level: "Academic", year: "2021", authors: "A-Tjak et al.", url: "https://doi.org/10.1016/j.jcbs.2021.09.004", summary: "Comprehensive meta-analytic review confirming ACT's efficacy across anxiety, depression, and chronic pain." },
    ],
  },

  dbt: {
    plainSummary: "DBT has one of the clearest, most structured evidence bases of any therapy — partly because Marsha Linehan insisted on rigorous trials from the start. The Behavioral Tech resources are the best starting point; the original 1991 trial below is the study that changed how clinicians treat self-harm.",
    keyResources: [
      { title: "What is DBT?", source: "Behavioral Tech (Linehan Institute)", level: "Beginner", year: "2024", url: "https://behavioraltech.org/resources/faqs/dialectical-behavior-therapy-dbt/", note: "Official FAQ from the organization founded by DBT's creator." },
      { title: "Find a DBT Therapist", source: "Behavioral Tech Clinical Resource Directory", level: "Beginner", year: "2024", url: "https://behavioraltech.org/resources/find-a-therapist/", note: "Directory of clinicians trained in comprehensive DBT." },
      { title: "DBT Skills Training Handouts and Worksheets", source: "Marsha Linehan (workbook)", level: "Intermediate", year: "2014", url: "https://www.guilford.com/books/DBT-Skills-Training-Handouts-and-Worksheets/Marsha-Linehan/9781462515696", note: "The standard worksheet companion used in most DBT skills groups." },
    ],
    research: [
      { title: "Cognitive-Behavioral Treatment of Chronically Parasuicidal Borderline Patients", source: "Archives of General Psychiatry", level: "Academic", year: "1991", authors: "Linehan, Armstrong, Suarez, Allmon & Heard", url: "https://doi.org/10.1001/archpsyc.1991.01810360024003", summary: "The landmark randomized controlled trial proving DBT reduces suicide attempts and self-harm." },
      { title: "Mechanisms of Change in Dialectical Behavior Therapy", source: "Clinical Psychology Review (open access)", level: "Academic", year: "2015", authors: "Lynch, Hempel & Dunkley", url: "https://doi.org/10.1016/j.cpr.2015.02.005", summary: "Reviews what's actually driving DBT's effects — useful for understanding mechanism, not just outcome." },
    ],
  },

  ifs: {
    plainSummary: "IFS research is younger than CBT or DBT's, but it's growing quickly, especially since 2021 when it joined SAMHSA's evidence-based registry. The IFS Institute is the best starting point; the studies below track its move from clinical theory to measured outcomes.",
    keyResources: [
      { title: "What is IFS?", source: "IFS Institute", level: "Beginner", year: "2024", url: "https://ifs-institute.com/", note: "Official site founded by Richard Schwartz with explanations of parts, Self, and the model's core ideas." },
      { title: "Find an IFS Practitioner", source: "IFS Institute Directory", level: "Beginner", year: "2024", url: "https://ifs-institute.com/practitioners", note: "Searchable global directory of certified IFS therapists." },
      { title: "No Bad Parts", source: "Richard Schwartz (book)", level: "Intermediate", year: "2021", url: "https://www.soundstrue.com/products/no-bad-parts", note: "Schwartz's most accessible recent book, written for a general audience." },
    ],
    research: [
      { title: "Efficacy of Internal Family Systems Therapy for Rheumatoid Arthritis", source: "Journal of Rheumatology", level: "Academic", year: "2013", authors: "Shadick et al.", url: "https://doi.org/10.3899/jrheum.121465", summary: "One of the first randomized controlled trials of IFS, notable for testing it outside typical mental health settings." },
      { title: "Internal Family Systems Therapy: A Systematic Review", source: "Journal of Marital and Family Therapy", level: "Academic", year: "2023", authors: "Hodgdon et al.", url: "https://doi.org/10.1111/jmft.12628", summary: "A 2023 systematic review of the (still emerging) evidence base across trauma, anxiety, and physical health outcomes." },
    ],
  },

  somatic: {
    plainSummary: "Somatic Experiencing's evidence base is the newest of the five modalities here, and much of the foundational thinking comes from Peter Levine's own clinical writing rather than randomized trials. The resources below mix his accessible books with the smaller but growing body of formal research.",
    keyResources: [
      { title: "What is Somatic Experiencing?", source: "Somatic Experiencing International", level: "Beginner", year: "2024", url: "https://traumahealing.org/", note: "Official organization founded by Peter Levine; explains the model and training pathway." },
      { title: "Find an SE Practitioner", source: "SE International Directory", level: "Beginner", year: "2024", url: "https://traumahealing.org/practitioner-directory/", note: "Directory of trained Somatic Experiencing practitioners." },
      { title: "Waking the Tiger: Healing Trauma", source: "Peter Levine (book)", level: "Intermediate", year: "1997", url: "https://www.northatlanticbooks.com/shop/waking-the-tiger/", note: "The original, most widely-read introduction to SE, written for a general audience." },
    ],
    research: [
      { title: "Effect of Somatic Experiencing for Post-Traumatic Stress Disorder Symptoms", source: "European Journal of Psychotraumatology (open access)", level: "Academic", year: "2017", authors: "Brom et al.", url: "https://doi.org/10.1080/20008198.2017.1338030", summary: "One of the few randomized controlled trials of SE; found significant PTSD symptom reduction versus waitlist control." },
      { title: "The Body Keeps the Score: Brain, Mind, and Body in the Healing of Trauma", source: "Bessel van der Kolk (book)", level: "Academic", year: "2014", url: "https://www.besselvanderkolk.com/resources/the-body-keeps-the-score", summary: "Not SE-specific, but the most influential synthesis of why body-based trauma treatment matters — widely cited alongside SE." },
    ],
  },
};

const LEVEL_COLORS = {
  Beginner: { bg:"#0d2616", border:"#1D9E75", text:"#5DCAA5" },
  Intermediate: { bg:"#1a1530", border:"#7F77DD", text:"#AFA9EC" },
  Academic: { bg:"#2a1810", border:"#D85A30", text:"#F0997B" },
};

// ── IFS swipeable character feed ───────────────────────────────────────────────
// An Instagram-Stories-style feed specific to IFS — each "part" of the internal
// family gets a full card, swipeable/tappable through dots. Lives on the
// Overview tab for the ifs node only.
const IFS_PARTS = [
  {
    id: "self", emoji: "✦", color: "#7F77DD", bg: "#1a1530",
    title: "The Core Self", subtitle: "Always present, never damaged",
    body: "At the deepest center of every person is the core Self. It is unburdened by trauma, cannot be damaged, and serves as the compassionate leader of your internal system.",
    qualities: ["Calmness","Curiosity","Clarity","Compassion","Confidence","Courage","Creativity","Connectedness","Choice"],
  },
  {
    id: "exile", emoji: "🜸", color: "#D85A30", bg: "#2a1810",
    title: "Exiles", subtitle: "The vulnerable parts",
    body: "Sensitive, often young parts that carry emotional wounds, pain, fear, and shame from past experiences. They're typically frozen in time at the age the trauma occurred.",
    relation: "protected-by-protectors",
  },
  {
    id: "manager", emoji: "⛨", color: "#378ADD", bg: "#0c2236",
    title: "Managers", subtitle: "Proactive protectors",
    body: "Attempt to keep your life, emotions, and environment controlled and predictable so Exiles are never triggered in the first place.",
    examples: [
      { name: "The Inner Critic", desc: "Pushes you to be flawless" },
      { name: "The Controller", desc: "Motivates and manages to avoid failure" },
      { name: "The People Pleaser", desc: "Keeps others happy to maintain safety" },
    ],
    relation: "guards-exile",
  },
  {
    id: "firefighter", emoji: "🔥", color: "#F0B429", bg: "#2e2310",
    title: "Firefighters", subtitle: "Reactive protectors",
    body: "Jump in when an exile's pain breaks through. They act impulsively to distract, numb, or soothe the system fast.",
    examples: [
      { name: "The Numbing Agent", desc: "Causes dissociation or avoidance" },
      { name: "The Rager", desc: "Erupts with overwhelming energy to externalize pain" },
      { name: "The Addicted", desc: "Turns to substances or impulsive behavior to escape" },
    ],
    relation: "rescues-exile",
  },
];

// ── Small inline diagrams per card ──────────────────────────────────────────────
// Self gets the full system map (Self in center, three part-types radiating out).
// Each part card gets a 2-node "relation" diagram showing how it connects to Exiles.
function SelfSystemDiagram({ size }) {
  const r = size === "sm" ? 70 : 100;
  const W = r * 2.6, H = r * 2.4;
  const cx = W/2, cy = H/2 + 6;
  const nodeR = size === "sm" ? 13 : 17;
  const orbit = r * 0.92;
  const nodes = [
    { label:"Exiles", color:"#D85A30", angle:-90 },
    { label:"Managers", color:"#378ADD", angle:30 },
    { label:"Firefighters", color:"#F0B429", angle:150 },
  ];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{maxHeight: size==="sm"?150:210, display:"block", margin:"0 auto"}}>
      {nodes.map((n,i) => {
        const rad = (n.angle * Math.PI) / 180;
        const nx = cx + Math.cos(rad)*orbit, ny = cy + Math.sin(rad)*orbit;
        return (
          <g key={i}>
            <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#3a3568" strokeWidth="1.5" strokeDasharray="3 4" opacity="0.7"/>
          </g>
        );
      })}
      {nodes.map((n,i) => {
        const rad = (n.angle * Math.PI) / 180;
        const nx = cx + Math.cos(rad)*orbit, ny = cy + Math.sin(rad)*orbit;
        return (
          <g key={i} transform={`translate(${nx},${ny})`}>
            <circle r={nodeR} fill={n.color} opacity="0.9"/>
            <text textAnchor="middle" dy={nodeR + 13} fontSize={size==="sm"?9:10.5} fill="#94a3b8" fontFamily="Inter,sans-serif">{n.label}</text>
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r={nodeR*1.5} fill="#7F77DD"/>
      <text x={cx} y={cy+1} textAnchor="middle" dominantBaseline="middle" fontSize={size==="sm"?11:13} fontWeight="700" fill="#fff" fontFamily="Inter,sans-serif">Self</text>
    </svg>
  );
}

function RelationDiagram({ part, size }) {
  const W = 220, H = size==="sm" ? 70 : 86;
  const nodeR = size==="sm" ? 16 : 20;
  const exileX = part.relation === "protected-by-protectors" ? W*0.78 : W*0.22;
  const partX  = part.relation === "protected-by-protectors" ? W*0.22 : W*0.78;
  const cy = H/2;
  const label = part.relation === "guards-exile" ? "shields"
              : part.relation === "rescues-exile" ? "rescues"
              : "carries pain";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{maxHeight:H+10, display:"block", margin:"0 auto"}}>
      <line x1={partX} y1={cy} x2={exileX} y2={cy} stroke={part.color} strokeWidth="2" strokeOpacity="0.55" strokeDasharray="2 5"/>
      <text x={(partX+exileX)/2} y={cy-10} textAnchor="middle" fontSize={size==="sm"?9.5:10.5} fill="#94a3b8" fontFamily="Inter,sans-serif">{label} →</text>

      <g transform={`translate(${partX},${cy})`}>
        <circle r={nodeR} fill={part.color}/>
        <text textAnchor="middle" dominantBaseline="middle" fontSize={size==="sm"?12:14} fill="#fff">{part.emoji}</text>
        <text textAnchor="middle" dy={nodeR+13} fontSize={size==="sm"?9:10} fill="#cbd5e1" fontFamily="Inter,sans-serif">{part.title}</text>
      </g>
      <g transform={`translate(${exileX},${cy})`}>
        <circle r={nodeR} fill="#D85A30"/>
        <text textAnchor="middle" dominantBaseline="middle" fontSize={size==="sm"?12:14} fill="#fff">🜸</text>
        <text textAnchor="middle" dy={nodeR+13} fontSize={size==="sm"?9:10} fill="#cbd5e1" fontFamily="Inter,sans-serif">Exiles</text>
      </g>
    </svg>
  );
}

function IFSFeed({ fullscreen }) {
  const [active, setActive] = useState(0);
  const [liked, setLiked] = useState({});
  const [dir, setDir] = useState(0); // +1 next, -1 prev — drives slide direction
  const part = IFS_PARTS[active];
  const toggleLike = (id) => setLiked(p => ({...p, [id]: !p[id]}));

  const cardMinHeight = fullscreen ? 520 : 400;
  const iconSize = fullscreen ? 64 : 46;

  const goTo = (i) => {
    if (i === active) return;
    setDir(i > active ? 1 : -1);
    setActive(i);
  };
  const next = () => goTo((active + 1) % IFS_PARTS.length);
  const prev = () => goTo((active - 1 + IFS_PARTS.length) % IFS_PARTS.length);

  // ── Swipe gesture ──────────────────────────────────────────────────────────
  const touchRef = useRef(null);
  const onTouchStart = (e) => { touchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; };
  const onTouchEnd = (e) => {
    if (!touchRef.current) return;
    const dx = e.changedTouches[0].clientX - touchRef.current.x;
    const dy = e.changedTouches[0].clientY - touchRef.current.y;
    touchRef.current = null;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.3) return; // not a horizontal swipe
    e.stopPropagation();
    if (dx < 0) next(); else prev();
  };

  return (
    <div style={{maxWidth: fullscreen ? 420 : "100%", margin: fullscreen ? "0 auto" : 0}}>
      <style>{`
        @keyframes ifsBreathe { 0%,100% { transform: scale(1); opacity:0.9; } 50% { transform: scale(1.06); opacity:1; } }
        @keyframes ifsSlideInR { from { opacity:0; transform: translateX(24px); } to { opacity:1; transform: translateX(0); } }
        @keyframes ifsSlideInL { from { opacity:0; transform: translateX(-24px); } to { opacity:1; transform: translateX(0); } }
        @keyframes ifsFadeUp { from { opacity:0; transform: translateY(8px); } to { opacity:1; transform: translateY(0); } }
        @keyframes ifsDashFlow { to { stroke-dashoffset: -20; } }
      `}</style>

      <div
        key={part.id}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        style={{
          background: part.bg, borderRadius: 18, padding: fullscreen ? "26px 22px 20px" : "18px 16px 16px",
          border: `1px solid ${part.color}33`, position:"relative", overflow:"hidden",
          minHeight: cardMinHeight, display:"flex", flexDirection:"column",
          transition:"background 0.3s ease, border-color 0.3s ease",
          animation: `${dir >= 0 ? "ifsSlideInR" : "ifsSlideInL"} 0.32s ease`,
          touchAction: "pan-y",
        }}
      >
        <div style={{display:"flex", alignItems:"center", gap:10, marginBottom: fullscreen?14:10, animation:"ifsFadeUp 0.35s ease"}}>
          <div style={{
            width: fullscreen?34:28, height: fullscreen?34:28, borderRadius:"50%", background:part.color,
            display:"flex", alignItems:"center", justifyContent:"center", fontSize: fullscreen?16:13, flexShrink:0,
            animation:"ifsBreathe 3.2s ease-in-out infinite",
          }}>{part.emoji}</div>
          <div>
            <p style={{margin:0, fontSize: fullscreen?13:12, fontWeight:600, color:"#fff"}}>{part.title}</p>
            <p style={{margin:0, fontSize: fullscreen?11:10, color:"#94a3b8"}}>{part.subtitle}</p>
          </div>
        </div>

        {/* Diagram block — system map for Self, relation diagram for parts */}
        <div style={{marginBottom: fullscreen?14:10, animation:"ifsFadeUp 0.4s ease"}}>
          {part.id === "self"
            ? <SelfSystemDiagram size={fullscreen?"lg":"sm"}/>
            : <RelationDiagram part={part} size={fullscreen?"lg":"sm"}/>
          }
        </div>

        <p style={{fontSize: fullscreen?14:12.5, lineHeight:1.6, color:"#e2e8f0", margin:"0 0 12px", animation:"ifsFadeUp 0.45s ease"}}>{part.body}</p>

        {part.qualities && (
          <div style={{display:"flex", flexWrap:"wrap", gap:6, marginBottom:14, animation:"ifsFadeUp 0.5s ease"}}>
            {part.qualities.map(q=>(
              <span key={q} style={{
                fontSize: fullscreen?11.5:10.5, padding:"3px 9px", borderRadius:20,
                background:"rgba(255,255,255,0.08)", color:"#cbd5e1"
              }}>{q}</span>
            ))}
          </div>
        )}

        {part.examples && (
          <div style={{display:"flex", flexDirection:"column", gap:7, marginBottom:14, animation:"ifsFadeUp 0.5s ease"}}>
            {part.examples.map((ex,i) => (
              <div key={i} style={{
                background:"rgba(255,255,255,0.06)", borderRadius:10, padding: fullscreen?"8px 12px":"7px 10px"
              }}>
                <span style={{fontSize: fullscreen?12.5:11.5, fontWeight:600, color: part.color}}>{ex.name}</span>
                <span style={{fontSize: fullscreen?12:11, color:"#94a3b8"}}> — {ex.desc}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{display:"flex", alignItems:"center", gap:14, paddingTop:8, marginTop:"auto", borderTop:"1px solid rgba(255,255,255,0.08)"}}>
          <button onClick={()=>toggleLike(part.id)} style={{
            background:"none", border:"none", cursor:"pointer", fontSize:18,
            color: liked[part.id] ? "#D4537E" : "#94a3b8", fontFamily:"inherit"
          }}>♥</button>
          <span style={{fontSize:11, color:"#64748b"}}>Resonates with {liked[part.id]?1:0} of you</span>
          <span style={{marginLeft:"auto", fontSize:10, color:"#475569"}}>Swipe →</span>
        </div>
      </div>

      <div style={{display:"flex", justifyContent:"center", gap:6, marginTop:12}}>
        {IFS_PARTS.map((p,i)=>(
          <button key={p.id} onClick={()=>goTo(i)} style={{
            width: i===active?20:8, height:8, borderRadius:4, border:"none", cursor:"pointer",
            background: i===active ? p.color : "#334155", transition:"all 0.25s ease"
          }}/>
        ))}
      </div>
      <p style={{textAlign:"center", fontSize: fullscreen?11:10, color:"#475569", marginTop:8}}>
        Swipe or tap a dot to meet the next part →
      </p>
    </div>
  );
}

// ── Somatic Experiencing swipeable practice feed ───────────────────────────────
// Mirrors the IFS feed pattern, but content is the four core SE practices rather
// than internal "parts" — each gets its own small diagram suited to the concept.
const SOMATIC_PRACTICES = [
  {
    id: "ffr", emoji: "⚡", color: "#D85A30", bg: "#2a1810",
    title: "Fight, Flight, Freeze", subtitle: "The nervous system's survival responses",
    body: "When we sense danger, the body automatically prepares to fight, flee, or freeze. Trauma occurs when one of these responses can't complete — the energy stays mobilized in the body long after the danger has passed.",
    diagram: "arousal",
  },
  {
    id: "tracking", emoji: "◉", color: "#378ADD", bg: "#0c2236",
    title: "Tracking Sensation", subtitle: "Following the body's felt sense",
    body: "Rather than talking about what happened, SE asks: what do you notice in your body right now? Tracking builds interoceptive awareness — the foundation every other SE technique relies on.",
    diagram: "body",
    tryIt: "Pause right now and scan from head to feet. Where do you notice warmth, tightness, ease, or nothing at all? Just notice — no need to change it.",
  },
  {
    id: "titration", emoji: "○", color: "#7F77DD", bg: "#1a1530",
    title: "Titration", subtitle: "Working in small, safe doses",
    body: "Leaning into emotions that follow trauma all at once can overwhelm the system. Titration means approaching it in small, manageable increments — like cracking a door instead of throwing it open. When you swim out to sea, you want to make sure you have enough energy to get back to the shore.",
    diagram: "dose",
    tryIt: "Let yourself feel a difficult emotion for just a few seconds, then pull back to something neutral or pleasant. A small dose is enough — you don't need the whole wave at once.",
  },
  {
    id: "pendulation", emoji: "↔", color: "#F0B429", bg: "#2e2310",
    title: "Pendulation", subtitle: "Moving between ease and activation",
    body: "The nervous system heals by rhythmically moving between a felt sense of safety and brief contact with activation, then back to safety again — like a pendulum, never staying too long in distress.",
    diagram: "pendulum",
    tryIt: "Sit with the emotion that follows trauma, then shift focus to something that brings you peace — a good memory, a safe moment. Then visit the strong emotion again, let it be present, and repeat.",
  },
];

// ── Traced ghost-character figures ─────────────────────────────────────────────
// Both figures are real traced vector data (via vtracer) from hand-drawn
// reference illustrations, not hand-coded curves — this keeps proportions
// faithful to the reference art. Shared viewBox/scale so they're interchangeable.
const GHOST_VIEWBOX = "420 30 540 1000";

function FrowningGhostFigure({ size, color = "#FCA88B" }) {
  const H = size === "sm" ? 150 : 190;
  return (
    <svg viewBox={GHOST_VIEWBOX} width="100%" style={{maxHeight:H, display:"block", margin:"0 auto"}}>
      <path d="M0 0 C14.866430918872652 13.651990083246403 18.788856719272644 37.627574263199264 22.515625 56.2734375 C22.967624917213016 58.51585207487696 23.42075091224592 60.75803996086999 23.875 63 C23.990048828125055 63.57701660156249 23.990048828125055 63.57701660156249 24.572265625 66.4970703125 C27.010865109382166 77.99661154680342 27.010865109382166 77.99661154680342 30.875 83 C33.35334850423851 84.60278172046412 35.46449020987461 85.77396867183839 38.125 86.9375 C39.56009498251137 87.61025242787619 40.99498491969359 88.28344239609527 42.4296875 88.95703125 C43.164130859375064 89.2929931640625 43.898574218750014 89.62895507812499 44.6552734375 89.97509765625 C48.22163111284635 91.62177270256592 51.73669325812375 93.36855662946488 55.25 95.125 C55.58471313476559 95.29217529296875 55.58471313476559 95.29217529296875 57.278564453125 96.13818359375 C74.25770775697697 104.68780060914042 91.56086983058594 116.08618021650653 97.875 135 C99.1031982367092 144.86437110114863 97.34119270683755 151.9619070667336 91.4765625 159.890625 C80.69473106662485 172.04070915334654 62.22854797908337 177.50908803843998 46.875 181 C43.375 181.125 43.375 181.125 40.875 181 C40.875 179.68 40.875 178.36 40.875 177 C44.92474474360597 175.44592188168616 48.963492675314455 173.94253281491268 53.1015625 172.640625 C76.95415318040773 165.13396377437942 76.95415318040773 165.13396377437942 84.875 157 C85.53500000000008 157 86.19499999999994 157 86.875 157 C90.79543647454125 149.3645647701073 93.19640557941284 142.56018307408468 90.875 134 C81.71239897399175 112.40725272914972 56.84002096691415 102.31287239194936 36.73046875 93.64453125 C29.31677363840322 90.30779904155474 23.785295779089438 85.78210710032045 20.703125 78.06640625 C19.577421681700343 74.07569571586399 18.69768997704523 70.06106887545133 17.875 66 C8.927246646193566 22.693955067076075 8.927246646193566 22.693955067076075 -0.125 10 C-0.4343750000000455 9.535937500000003 -0.4343750000000455 9.535937500000003 -2 7.1875 C-7.233687205343472 1.7998808180287895 -13.186140410305597 -1.120716624078156 -20.6875 -1.375 C-27.25579344187065 -1.3036916272897017 -31.68842347641339 0.4096329101910783 -37.125 4 C-37.77726562500004 4.426679687499998 -38.42953124999997 4.853359374999997 -39.1015625 5.29296875 C-52.20483580980351 15.349596207935633 -60.18220485935365 32.86404737689915 -68.249755859375 46.93408203125 C-77.80816623038118 63.585937753472095 -77.80816623038118 63.585937753472095 -82.5625 66.8125 C-83.09746093750005 67.19019531250001 -83.63242187499998 67.56789062500002 -84.18359375 67.95703125 C-88.7299822415954 70.39945726057539 -93.4487242444336 71.31521402557604 -98.52734375 71.9296875 C-99.74059326171869 72.08308593750002 -100.95384277343749 72.236484375 -102.203857421875 72.39453125 C-103.47720947265623 72.55308593749999 -104.75056152343745 72.711640625 -106.0625 72.875 C-116.35502031181022 74.22859268423042 -126.25469752625213 75.68808153069202 -136.125 79 C-136.58003906249996 79.14759765625001 -136.58003906249996 79.14759765625001 -138.8828125 79.89453125 C-147.6567793332997 83.04725633535998 -155.82946293590612 88.222179937112 -161.125 96 C-164.28048448449772 102.91201363270937 -163.79208998886952 109.68499551855388 -161.22265625 116.65234375 C-154.5716610900855 130.87742592476368 -141.36513714475655 142.59679917870108 -129.1875 152.0625 C-124.26841835866094 156.33122228971968 -122.34298503086495 161.1412820237997 -121.8515625 167.5859375 C-121.75562500000001 176.89187499999997 -121.75562500000001 176.89187499999997 -123.125 181 C-122.2311962890625 180.9895263671875 -121.33739257812499 180.979052734375 -120.41650390625 180.96826171875 C-105.07134037286687 180.8131013553637 -89.75231243508074 180.69507180799746 -74.4375 181.8125 C-73.3896533203125 181.8825927734375 -72.34180664062501 181.952685546875 -71.26220703125 182.02490234375 C-64.9829526196844 182.5436008532627 -59.286803162426054 183.21392680979045 -54.3828125 187.53515625 C-47.890338528061875 196.28880219147516 -49.56693352247714 206.99636313488384 -50.996337890625 217.41162109375 C-52.50328880197401 227.2150606137443 -54.035788382612736 236.5463671660375 -61.26953125 243.84375 C-66.62843130629437 247.18319087718555 -72.55294587535718 247.288684236344 -78.6640625 247.23046875 C-79.46677581787105 247.23001052856443 -80.26948913574222 247.22955230712887 -81.09652709960938 247.2290802001953 C-82.78913863710977 247.22607340260777 -84.4817477955637 247.21823454906973 -86.17431640625 247.205810546875 C-88.72178336665763 247.18770059218014 -91.26888193280581 247.18530035629306 -93.81640625 247.185546875 C-123.63750266765771 247.12223592157022 -123.63750266765771 247.12223592157022 -129.8046875 241.45703125 C-135.5986731962978 235.17790321071078 -136.5191583667554 228.9721727644801 -136.38720703125 220.60693359375 C-135.93352311030844 214.36603392150482 -134.51267555637628 208.38651690907955 -133.0625 202.3125 C-132.4823786979132 199.8307994626265 -131.90784461914507 197.3477838752724 -131.33984375 194.86328125 C-131.0832397460938 193.78344970703125 -130.82663574218748 192.7036181640625 -130.562255859375 191.591064453125 C-130.125 189 -130.125 189 -131.125 187 C-131.681875 187.20625 -131.681875 187.20625 -134.5 188.25 C-134.8132421875 188.366015625 -134.8132421875 188.366015625 -136.3984375 188.953125 C-138.7751534418736 190.394210684213 -139.25359801024888 191.34265531838273 -140.125 194 C-140.3220129306943 196.79294801749063 -140.40801635684898 199.45982305736425 -140.375 202.25 C-140.37113281250004 203.04414306640626 -140.36726562499996 203.83828613281253 -140.36328125 204.656494140625 C-140.2871424145177 209.97722401186206 -139.85292961361301 215.16910144678718 -139.125 220.4375 C-136.76008182217208 237.92408477474214 -141.9203253096266 250.47489910156617 -148.71609497070313 266.2749328613281 C-164.65523244763096 303.4685524167379 -173.86237697674005 342.01649844298635 -158.616455078125 381.3310546875 C-154.27819706336186 391.8177406251893 -148.43400690330975 401.3214553140188 -141.125 410 C-140.24547395912032 411.0750140476466 -139.36661801739524 412.1505765417902 -138.48828125 413.2265625 C-134.21981045917312 418.40944308311015 -130.0232910311645 423.34015823779407 -124.75390625 427.54296875 C-118.32859742640755 433.29030733800954 -114.01308741345213 440.1850621885214 -113.171875 448.83984375 C-112.95536946681545 458.817140404253 -118.20071969669527 466.59507141148424 -124.64453125 473.828125 C-129.8499546845112 479.160146715465 -135.36749829509677 483.98324543647846 -141.18359375 488.6328125 C-154.16516119814264 499.08012972918254 -167.601953931386 510.0267348712921 -178.125 523 C-178.73343750000004 523.7205859375 -179.34187499999996 524.441171875 -179.96875 525.18359375 C-216.0220792741569 568.7480332896062 -232.32536705746395 628.2397406642368 -232.375 684.0625 C-232.37567474365233 684.7539813232422 -232.37634948730465 685.4454626464844 -232.37704467773438 686.1578979492188 C-232.338897687712 711.0718040870398 -231.7833247434785 742.6957398855376 -217.125 764 C-213.94086681751537 766.993286083219 -212.63267812259392 767.9181164318397 -208.25 768.625 C-204.0147520474393 768.3928219458899 -201.61290143847305 766.6814913304114 -198.6015625 763.80078125 C-196.34431002948304 761.0478886867504 -195.26779912140034 758.3611738864716 -194.125 755 C-194.5001171875 754.56171875 -194.875234375 754.1234375 -195.26171875 753.671875 C-203.2845352979325 743.7292408902197 -208.21412192967693 730.860907892993 -207.125 718 C-206.12251773962612 712.5319149434151 -204.6664089455902 709.3303665600995 -200.125 706 C-195.0441872897843 705.2741696128263 -192.22680248186816 706.0192272643612 -188.125 709 C-179.17534937978564 721.8874968931087 -174.68140730112475 742.4091988521471 -176.125 758 C-177.25 760.5 -177.25 760.5 -179.125 762 C-183.19273990881118 762.5192859458057 -185.58490039868855 761.911500864639 -189.125 760 C-189.4769140625 760.5916796875 -189.82882812499997 761.183359375 -190.19140625 761.79296875 C-193.84113971128818 767.6344481540984 -197.31875579295183 772.4802389859136 -204.1015625 774.625 C-210.34248521164852 775.7816188809232 -214.44396857745028 773.5693842473462 -219.6875 770.5 C-235.9435326646411 753.8271459849835 -238.1628276099641 721.5719899526925 -238.36328125 699.3671875 C-238.36817817687984 698.916093673706 -238.36817817687984 698.916093673706 -238.39295959472656 696.6332855224609 C-238.99455687399688 626.6911440891354 -221.4250957647116 558.1027452012755 -171.425048828125 507.068359375 C-165.1487023529877 500.74336910678267 -158.85024475863202 494.636345887542 -151.8359375 489.1328125 C-122.00991452645223 465.6673823219638 -122.00991452645223 465.6673823219638 -119.81640625 452.08984375 C-119.39352066548463 445.028935960062 -122.06668096149588 440.61965401112946 -126.125 435 C-129.02536990589329 431.7789047524004 -132.14887501191583 428.83503623079446 -135.3125 425.875 C-143.5396818826198 417.9002725083869 -150.29118510243586 409.85070515532544 -156.125 400 C-156.50188964843755 399.3714208984375 -156.878779296875 398.742841796875 -157.26708984375 398.09521484375 C-174.84461663787954 368.3291718687805 -176.7534780088273 333.51947031394036 -168.377685546875 300.52587890625 C-164.68002361539106 286.99350878133566 -159.04153086439237 274.16535138735287 -153.533203125 261.29541015625 C-151.63605661013344 256.85579787163323 -149.78021627593012 252.39991549039854 -147.9375 247.9375 C-147.65849853515624 247.272021484375 -147.37949707031248 246.60654296874998 -147.092041015625 245.9208984375 C-144.895031185398 240.62774915169769 -143.9462511292237 237.03884877725824 -144.4375 231.3125 C-144.53546875000006 230.16652343750002 -144.6334375 229.02054687500004 -144.734375 227.83984375 C-145.08336699643655 224.40925242502914 -145.4855101066231 220.99219398364517 -145.9140625 217.571044921875 C-148.640960620525 195.67064439140813 -148.640960620525 195.67064439140813 -144.125 187 C-140.88403698518232 183.58384979519212 -137.66759606009714 182.13564901502426 -133.125 181 C-131.45858679091862 180.97093465332998 -129.79132436893246 180.9662231546838 -128.125 181 C-128.04316998884167 178.645114123332 -127.98412432248938 176.29313838862748 -127.9375 173.9375 C-127.90269531249999 172.6265234375 -127.86789062499997 171.315546875 -127.83203125 169.96484375 C-128.4103901415475 162.13772008439048 -131.63547210714887 157.90056430939276 -137.3125 153 C-137.89620361328127 152.47728515625 -138.47990722656255 151.9545703125 -139.081298828125 151.416015625 C-141.4900288793939 149.26721086946995 -143.9292748198044 147.16355117797167 -146.40625 145.09375 C-156.76083278610645 136.43663980177982 -164.8229994155903 125.90600175322916 -169.125 113 C-169.75570685083096 104.86284767862338 -170.021495249228 97.78448558043505 -165.125 91 C-164.72410156249998 90.409609375 -164.32320312499996 89.81921875 -163.91015625 89.2109375 C-154.0730764720338 76.26591077769089 -135.49432183621843 70.66540712348774 -120.125 68 C-114.78959238995367 67.2925522406617 -109.4416494236284 66.69756759578128 -104.081298828125 66.21435546875 C-88.6025992032454 64.662673927198 -88.6025992032454 64.662673927198 -83.244140625 59.01904296875 C-81.3612377761167 56.424975621607985 -79.73273490563031 53.77336540751014 -78.125 51 C-77.46918945312495 49.899462890625 -76.81337890625002 48.798925781250006 -76.1376953125 47.6650390625 C-73.60636530088425 43.38526001628108 -71.13865016581406 39.06943084997832 -68.6826171875 34.74609375 C-59.08241404520538 17.88634194373367 -48.24435413391734 -0.14589191425603332 -29.125 -7 C-18.0826127737364 -9.944636593670282 -9.173387850498102 -5.870968224318766 0 0 Z M-123.125 186 C-127.83594544555342 199.67484508407256 -134.81920741014187 220.11899325611625 -129.19921875 234.15625 C-127.39093084529634 237.25992960370957 -125.34373480247677 238.5144300911645 -122.125 240 C-116.20111231959197 241.13645435106974 -110.34407826660981 241.17697004272264 -104.3359375 241.203125 C-103.31448638916015 241.20882507324222 -102.2930352783203 241.2145251464844 -101.24063110351563 241.22039794921875 C-99.09076969683406 241.22980653305547 -96.94089413788606 241.2363653674783 -94.791015625 241.240234375 C-91.50365358689965 241.24998915849585 -88.21690441957912 241.2810715741182 -84.9296875 241.3125 C-82.83594119319764 241.31902625370282 -80.74219044421272 241.3242782043855 -78.6484375 241.328125 C-77.66813568115231 241.34047180175781 -76.68783386230461 241.35281860351563 -75.67782592773438 241.36553955078125 C-67.06076024742072 241.33736901079186 -67.06076024742072 241.33736901079186 -63.125 238 C-55.98917374765438 227.50613786419768 -54.48070976902045 209.50763426662348 -55.125 197 C-57.09628950045396 191.71223288085784 -57.09628950045396 191.71223288085784 -59.712158203125 189.901123046875 C-63.22356482954126 188.58971943885086 -66.78393728904871 188.27220715399733 -70.48828125 187.9140625 C-71.31983230590822 187.8304849243164 -72.15138336181644 187.74690734863282 -73.00813293457031 187.66079711914063 C-83.09261158020593 186.71882971805724 -93.19128071186333 186.54384821472954 -103.3125 186.375 C-105.24936369586942 186.3366752048105 -107.18621300389032 186.29761604287467 -109.123046875 186.2578125 C-113.7902430430936 186.1634536196922 -118.45751757196535 186.07887618858945 -123.125 186 Z M-198.125 711 C-202.16286724661347 715.3698934658311 -201.60650742269604 719.5736750883485 -201.4765625 725.26171875 C-200.34523706153084 737.2914792457225 -195.02753940493562 747.9724849567684 -185.9921875 755.8828125 C-185.37601562500004 756.251484375 -184.75984374999996 756.62015625 -184.125 757 C-183.63 756.835 -183.63 756.835 -181.125 756 C-181.9132659147415 746.8114077699536 -183.1565669685806 737.88468382803 -185.4375 728.9375 C-185.62594482421878 728.1655932617188 -185.81438964843755 727.3936865234375 -186.008544921875 726.598388671875 C-187.4480497057499 721.2221840874474 -189.53729341872065 716.3185866303211 -193.125 712 C-195.9375 711 -195.9375 711 -198.125 711 Z " fill={color} transform="translate(765.125,61)"/>
<path d="M0 0 C1.32000000000005 0.3300000000000125 2.6399999999999864 0.6599999999999966 4 1 C3.0035480228480083 8.277883428059425 -2.275821374888096 12.804902323334915 -7.8125 17.25 C-15.281421601605757 22.531491768380164 -22.936110656616506 24.61430258113262 -32 25 C-32.65999999999997 23.680000000000007 -33.32000000000005 22.360000000000014 -34 21 C-31.65049774621616 18.650497746216132 -29.821771753618464 18.41707957184005 -26.64208984375 17.7587890625 C-15.41312651561816 15.419315052490333 -7.589894445517984 11.15434909609931 -0.9609375 1.50390625 C-0.8023828125000136 1.2557617187499943 -0.8023828125000136 1.2557617187499943 0 0 Z " fill={color} transform="translate(696,202)"/>
<path d="M0 0 C3 1 3 1 4.17578125 3.0390625 C4.5508984374999955 3.8924218749999966 4.926015624999991 4.745781249999993 5.3125 5.625 C11.08416858942087 17.66648714638103 19.779919768263312 22.517634505162164 32 27 C31.835000000000036 27.82499999999999 31.835000000000036 27.82499999999999 31 32 C20.520630802408732 30.30977916167882 10.58900740847048 25.121850132046745 4.1171875 16.48828125 C0.6542380470634725 11.349937223679234 -1.860903203405087 7.259355846770887 -2 1 C-1.3400000000000318 0.6699999999999875 -0.67999999999995 0.3400000000000034 0 0 Z " fill={color} transform="translate(753,209)"/>
<path d="M0 0 C1.239675292968741 0.26667480468751137 2.479350585937482 0.5333496093749943 3.756591796875 0.80810546875 C12.60282081136836 2.7445655518112346 21.408737126463052 4.840834074608949 30.1875 7.0625 C31.29496582031254 7.339084472656225 32.40243164062497 7.615668945312507 33.54345703125 7.900634765625 C41.21010958147281 9.9022002523825 49.19414108904539 12.013234950416347 54.375 18.4375 C58.42215124208167 30.578953726245118 51.86816800402232 45.08970751558883 46.5 56 C43.047901898654004 62.721265898216586 39.4489177716398 69.21536303365099 32.625 72.9375 C22.397908983438015 74.51089861793264 13.376119898772458 72.57101637984374 3.5 69.875 C2.129662190866952 69.50845698374621 0.7593006044600088 69.14200284909776 -0.611083984375 68.775634765625 C-4.624507333094357 67.69307071835317 -8.625504857490228 66.57046104915827 -12.625 65.4375 C-13.183405761718745 65.28023437499996 -13.183405761718745 65.28023437499996 -16.00927734375 64.484375 C-18.91388702248878 63.648858826838136 -21.80210339036364 62.774361409195706 -24.6875 61.875 C-25.518139648437455 61.63128662109375 -26.348779296875023 61.3875732421875 -27.20458984375 61.136474609375 C-32.906701089435956 59.26384536621288 -36.361565004152226 56.509673304974285 -39.625 51.4375 C-42.894611879932086 41.628664360203686 -40.98908594512193 28.730819736368915 -39.375 18.6875 C-39.265751953125005 17.974567871093768 -39.15650390625001 17.26163574218748 -39.0439453125 16.527099609375 C-37.809216056618766 9.644537254577585 -35.19265941496201 2.927547915291939 -29.625 -1.5625 C-20.20143669120864 -4.703687769597138 -9.410545210008536 -2.08603988585196 0 0 Z M-29.625 5.4375 C-32.55633693185564 11.904342544322674 -33.539353914068556 18.234971015470705 -34.375 25.25 C-34.51292968749999 26.266425781250007 -34.65085937499998 27.282851562500014 -34.79296875 28.330078125 C-35.731909408539536 35.92388169844594 -36.639967900949614 44.31995689805956 -33.1875 51.375 C-25.7431767654831 57.36677235948923 -15.032200870682459 59.13855221531685 -6 61.5625 C-5.364492187499991 61.735878906250036 -5.364492187499991 61.735878906250036 -2.1484375 62.61328125 C1.356417686777604 63.56616375390519 4.86491327038641 64.50410916854855 8.375 65.4375 C9.177763671875027 65.65752685546875 9.980527343750055 65.87755371093749 10.8076171875 66.104248046875 C15.01698522556535 67.22549641811219 19.020679564176135 67.84660916646533 23.375 68 C24.509374999999977 68.0631640625 25.643749999999955 68.12632812499999 26.8125 68.19140625 C32.03427413916427 67.08635974905843 34.964852935804174 64.4685383822586 38.375 60.4375 C40.35906072982277 57.171769954279796 41.79892675615747 53.804261407661556 43.1875 50.25 C43.565678710937505 49.32106933593752 43.94385742187501 48.39213867187499 44.33349609375 47.43505859375 C51.98079711584296 28.254891347528996 51.98079711584296 28.254891347528996 49.375 20.4375 C45.65479671809442 16.802535151048005 41.913383402113595 15.428826563904579 36.9609375 14.25390625 C36.24141906738282 14.073064880371078 35.52190063476564 13.892223510742213 34.78057861328125 13.705902099609375 C32.44031344143309 13.122951920499986 30.095745860306238 12.560454442285334 27.75 12 C26.130662315985205 11.604388413271522 24.511359192963823 11.208635334162636 22.89208984375 10.812744140625 C-23.002400813259214 -0.29015335069470893 -23.002400813259214 -0.29015335069470893 -29.625 5.4375 Z " fill={color} transform="translate(764.625,252.5625)"/>
<path d="M0 0 C3.8936471665547288 0.5768366172673609 6.011890412270304 2.548217774170496 9 5 C14.224945061132757 6.7416483537109 19.675663288612327 6.80658382694395 24.8125 4.6875 C27.45107404351984 3.29060785931307 29.720675212177525 1.9146328217709083 32 0 C33.32000000000005 0.660000000000025 34.639999999999986 1.3199999999999932 36 2 C34.779347441145546 5.661957676563475 32.411016170826656 7.764091045725195 29.24609375 9.8828125 C23.09771066495523 12.940964782300512 16.325917918800087 13.700082637741502 9.6875 12 C4.935400662515235 10.303370026519985 1.4997794137791516 7.580900128668077 -2 4 C-1.3400000000000318 2.680000000000007 -0.67999999999995 1.3600000000000136 0 0 Z " fill={color} transform="translate(662,276)"/>
<path d="M0 0 C1.8125 0.1875 1.8125 0.1875 4 1 C4.433125000000018 1.7631250000000023 4.866250000000036 2.5262500000000045 5.3125 3.3125 C8.20959008339912 7.926384206894909 12.326311591730246 9.535086553258395 17.375 10.9375 C21.404407978591507 11.006972551355034 24.177953909517328 10.166714690283243 27.91015625 8.76953125 C30.24202947691697 7.910878865509062 32.548745103701094 7.395363692951435 35 7 C35.164999999999964 7.660000000000025 35.164999999999964 7.660000000000025 36 11 C34.75443907651834 11.819288859862922 33.50333364980395 12.630151864268612 32.25 13.4375 C31.553906249999955 13.889960937500007 30.857812500000023 14.342421875000014 30.140625 14.80859375 C24.936973028549914 17.704786909292466 19.097419985547504 17.86746617555667 13.43359375 16.28125 C6.077999725811878 13.562639988079525 1.7791645000613698 9.961618815902568 -2 3 C-1.3400000000000318 2.009999999999991 -0.67999999999995 1.0199999999999818 0 0 Z " fill={color} transform="translate(741,281)"/>
<path d="M0 0 C0.8250000000000455 0.16500000000002046 0.8250000000000455 0.16500000000002046 5 1 C13.501291802701303 53.33419350882764 3.210236112946177 96.44796121507238 -23.564208984375 141.754150390625 C-34.11839802315899 159.6411767721179 -34.11839802315899 159.6411767721179 -35 170 C-35.06316406250005 170.70124999999996 -35.126328124999986 171.40250000000003 -35.19140625 172.125 C-35.89803406172291 186.3487340166149 -29.15967610679411 198.27088613725857 -20.0625 208.6875 C-15.781195065341535 213.27776508458226 -11.360382727454294 217.7339560404664 -6.9375 222.1875 C-6.276936035156268 222.8528979492187 -5.616372070312536 223.5182958984375 -4.935791015625 224.203857421875 C-1.0213418311479927 228.10472992145606 3.0082491439630985 231.80870995503346 7.189697265625 235.421142578125 C14.42860727429968 241.73456550814512 20.796149328133424 248.80094067708558 26.7060546875 256.35546875 C28.15559343417567 258.19775044766175 29.62942589212105 260.0194833331457 31.1015625 261.84375 C38.93606021956191 271.6765251045131 45.31376778154163 281.7976672476641 51 293 C51.38107910156248 293.7391162109375 51.762158203124955 294.47823242187496 52.15478515625 295.23974609375 C81.56221675913002 352.7389807020229 95.45413119287946 432.47135552207783 76.188720703125 495.261474609375 C73.06086666030342 504.88160737499675 68.88119423340663 514.9900948408591 60.25 520.875 C54.580297001199256 522.8375894995849 49.396558313234436 522.8900807118262 43.8125 520.5625 C36.96610015425881 516.7165144292849 33.70097317262571 509.0525410618559 31 502 C30.340000000000032 502.3299999999999 29.680000000000064 502.6600000000001 29 503 C27.124999999999886 503.16796875 27.124999999999886 503.16796875 25 503.1875 C24.29875000000004 503.2016796875 23.597499999999968 503.21585937500004 22.875 503.23046875 C21 503 21 503 19 501 C17.096416494935397 483.94191404552544 21.755251501993826 462.9050478615652 32 449 C34.723971790375344 446.84949595496687 36.51994935674816 446.0817107477876 39.9375 445.5 C44.1698011164616 446.19098793738146 46.0326609831302 447.9652214600196 49 451 C52.94187787515216 458.73576716113485 51.92589433910564 468.7624574355259 49.56201171875 476.90380859375 C47.17676164003478 484.19383404933865 43.741758742352545 490.02801165950564 39 496 C38.34000000000003 496.99 37.680000000000064 497.98 37 499 C38.289015745288 504.5110093457963 40.92622860851179 510.0496762264356 45 514 C48.06198434627231 515.8206393410268 49.85441026510318 516.002647086089 53.4375 515.9375 C57.56812477616404 514.8504934799569 60.12311946214436 513.0644076345347 63 510 C64.43220744880568 507.5176957853705 65.5604859240292 505.31035507888123 66.625 502.6875 C66.918583984375 501.98383300781256 67.21216796875001 501.280166015625 67.5146484375 500.55517578125 C70.47739044319383 493.20724823232194 72.49235739451854 485.7702922710753 74 478 C74.14953125 477.2786083984374 74.29906249999999 476.5572167968751 74.453125 475.81396484375 C85.84408324538435 418.7241514824542 72.46106415324891 350.5360666141057 47 299 C46.666455078124955 298.32050292968756 46.33291015625002 297.641005859375 45.9892578125 296.94091796875 C32.95973700437594 270.70685293866154 13.190724356694886 247.40438320697194 -9.0625 228.4375 C-23.77589495197617 215.83955024498175 -34.7845116791176 202.6464649626471 -41 184 C-42.27470692341899 163.81365757339825 -35.928169051609075 150.20193179428105 -26 133 C-9.724468742699514 104.70736453020504 2.1136813140414006 75.87278791591189 2.25 42.6875 C2.253947753906232 41.81955810546873 2.2578955078124636 40.951616210937516 2.261962890625 40.057373046875 C2.1811747771115506 30.45358194456668 1.1013776755705749 20.950859810696613 -0.0205078125 11.422607421875 C-0.1594042968749818 10.227404785156239 -0.2983007812499636 9.032202148437477 -0.44140625 7.80078125 C-0.57232666015625 6.729973144531243 -0.7032470703125 5.659165039062486 -0.838134765625 4.555908203125 C-1 2 -1 2 0 0 Z M34 455 C27.680083410206976 465.755847204309 23.719690233252095 482.0223432953725 23.9375 494.4375 C23.958124999999995 495.61312499999997 23.97874999999999 496.78874999999994 24 498 C27 499 27 499 28.796875 498.171875 C39.067491534949795 490.69486616255654 43.56975455876761 480.2235559395318 46 468 C46.78719274260118 461.9439831052159 46.091576437418894 457.2998453212896 43 452 C39.100476176592 449.5303015785082 37.000768354918705 452.2496821723852 34 455 Z " fill={color} transform="translate(819,323)"/>
<path d="M0 0 C5.061999787389595 4.2450048133849805 9.999207879462574 9.063860725539428 12.66015625 15.21875 C12.30859375 17.484375 12.30859375 17.484375 11.66015625 19.21875 C10.340156250000064 19.21875 9.020156250000014 19.21875 7.66015625 19.21875 C6.2734375 17.53125 6.2734375 17.53125 4.97265625 15.21875 C-1.1133716275543293 5.5419656746885835 -9.435908517169878 0.14298978172945453 -20.1953125 -3.390625 C-31.296801482674482 -5.412754140742152 -43.315631360229986 -4.299874433663035 -52.90234375 1.8671875 C-56.279340271282194 4.411043432150109 -59.29385117872482 7.109056566400682 -62.15234375 10.21875 C-62.874218749999955 10.878750000000025 -63.59609375000002 11.538749999999993 -64.33984375 12.21875 C-66.65234375 12.03125 -66.65234375 12.03125 -68.33984375 11.21875 C-67.74886746630511 5.329723173005618 -64.4725383205124 3.0688028424576714 -60.171875 -0.62890625 C-41.81157445720521 -14.582734662524047 -18.163239584280973 -13.827107262824939 0 0 Z " fill={color} transform="translate(734.33984375,402.78125)"/>
<path d="M0 0 C1.32000000000005 0.3300000000000409 2.6399999999999864 0.6599999999999682 4 1 C3.8672265625000364 2.281328124999959 3.734453124999959 3.562656250000032 3.59765625 4.8828125 C-1.9696767809963376 59.098532933227716 2.1055080070661916 111.92627205150211 36 157 C36.75539062500002 158.03898437500004 37.510781250000036 159.07796874999997 38.2890625 160.1484375 C44.37711065899987 168.40801076990624 51.253253508230955 175.81512755423057 58.32861328125 183.2314453125 C60.69972631982773 185.74040570564296 63.000191592663896 188.31187656482507 65.3125 190.875 C72.6123473005033 198.88849396587034 80.39758163350962 206.4496689505586 88.104736328125 214.06787109375 C93.62129004407916 219.53210426780583 99.0271275917039 225.02774680110156 104 231 C104.46736572265627 231.55550537109377 104.93473144531254 232.11101074218755 105.416259765625 232.683349609375 C117.45951157189552 247.174681023684 129.38469049019147 263.3194476259482 128.9375 282.9375 C129.09375 286.70703125 129.09375 286.70703125 130 290 C132.99513237070687 292.6762062386408 136.19634486292284 294.2668868194047 139.80078125 295.94140625 C144.48199525319967 298.117460819557 148.48750824767933 300.99839910259243 152.625 304.0625 C153.3749926757812 304.61019042968746 154.1249853515625 305.1578808593749 154.897705078125 305.72216796875 C158.9798256445024 308.7183852099598 163.01588903672496 311.7704774398104 167.03125 314.85546875 C180.85470862494458 325.45005162363907 194.33658857749492 334.4920104503017 211 340 C211.66644531249995 340.2333203124999 212.332890625 340.4666406250001 213.01953125 340.70703125 C226.95254876386366 344.92639820953605 243.11929570773054 343.7082148936231 256 337 C261.207017982103 332.9008581843018 263.51495526847316 328.21342134636575 264.5 321.6875 C263.307218029908 312.8907329705719 258.706791854123 306.7859376259312 251.99609375 301.1953125 C243.8294583201906 295.2114153532557 234.9295270919049 290.85052328086385 225.75390625 286.63671875 C225.42983291625978 286.4875022125244 225.42983291625978 286.4875022125244 223.78982543945313 285.7323760986328 C220.5353505017199 284.23732591482633 217.2746058670333 282.75999717653804 213.9990234375 281.311767578125 C197.15907476669463 273.7583486777146 184.30257128270466 264.5215048987578 177 247 C171.17419138265245 230.74906017266198 176.2356857828936 213.2185080560448 183.25 198.25 C189.31114191380334 185.80779855354774 197.34633974588849 175.15077069479128 205.7578125 164.234375 C243.15557592070854 115.55792102383975 256.9260441178358 61.79198886495385 249 1 C250.875 0.375 250.875 0.375 253 0 C260.285279601055 7.285279601055095 258.30299886963894 28.124676292053437 258.3125 37.75 C257.9141865868967 87.55664652446217 239.9482242120307 129.46788668014233 210.17626953125 168.710693359375 C184.50200962938652 202.55581088019653 184.50200962938652 202.55581088019653 182 222 C181.868515625 222.84562500000004 181.73703124999997 223.69124999999997 181.6015625 224.5625 C180.0563920523282 236.64916661289953 182.54943755750423 247.15859032424237 189.49609375 257.15234375 C199.13486692029107 269.19503157187444 215.60735073025194 274.80146863673224 229.181884765625 281.16064453125 C262.01124584620175 296.58312400010504 262.01124584620175 296.58312400010504 269.33984375 312.66796875 C271.1311059492143 318.9956819626092 271.14999912963594 326.2941984257459 268.5 332.375 C263.91917747775005 340.0204573082623 256.208536408089 345.00643326345767 247.87109375 347.68359375 C225.93744720673203 353.064945270768 202.8887883085082 346.4243776079081 184.05126953125 335.02099609375 C176.32767311072644 330.1273285858738 169.18398817062325 324.40347607120157 161.9609375 318.8125 C151.07585876225562 310.4007416106051 139.46100605119113 301.9466191946931 127 296 C126.89816406249997 296.879140625 126.79632812499995 297.75828125 126.69140625 298.6640625 C124.26691643245135 310.36188342760784 113.91309039170244 319.35558103466747 104.375 325.625 C81.70444908818615 339.93924299325977 51.83010065433325 345.93517753622154 25.296875 341.3125 C15.30790975365278 338.8860307093894 6.832319436232524 334.6601106780422 1 326 C-1.569042898210114 319.8109421088575 -1.4235190956679844 314.16998256828833 0.71875 307.89453125 C6.00963577545258 296.1040659659095 17.644133765256584 289.9009377919069 29.16015625 285.265625 C58.59332450170257 274.0999230990101 90.54697357596751 274.1228460722848 120 285 C121.34279578696044 285.6473960895336 122.67916477676124 286.30890193512505 124 287 C120.98807202544651 257.0155827010867 101.17876634254048 235.87772191151691 80.535888671875 215.579833984375 C79.10658299108445 214.10963257595085 77.79666588934151 212.52591571444339 76.5 210.9375 C74.5720590081039 208.6721693345221 72.88437704838384 206.9877308554453 70.625 205.125 C67.40195206097678 202.44717858599358 64.77867805323024 199.51487298414804 62.07421875 196.32421875 C59.54306244412419 193.4879889910619 56.83989903756867 190.8451316359949 54.125 188.1875 C49.463376295758735 183.59455716609114 45.20577093665611 178.8270322593703 41.13671875 173.69140625 C39.733349145449665 171.92372497479857 38.298921058379165 170.1801797601587 36.83203125 168.46484375 C2.3296401135778524 127.97796707133114 -8.341385252897794 76.07092188300157 -4.724609375 24.0380859375 C-2.97315898791544 4.45973848187316 -2.97315898791544 4.45973848187316 0 0 Z M42 287 C41.30986816406255 287.1819189453124 40.619736328124986 287.36383789062506 39.90869140625 287.55126953125 C26.444370047645066 291.20377270707513 13.158424229432967 297.52024080279534 5.84765625 309.9609375 C4.339387032270679 313.58912428181895 4.457544578279908 317.14923620383854 5 321 C8.861408270201991 328.57980141928533 15.187349906372901 332.31254349899586 23 335 C47.317427455500024 341.2101895080043 76.72195848408069 335.5492508492056 98.29736328125 323.0439453125 C109.24599808067194 316.3309595937835 118.26529293437852 307.0416347967009 123 295 C123 294.3399999999999 123 293.68000000000006 123 293 C97.87083933563486 280.51862880909016 68.84642590674753 279.6858965013405 42 287 Z " fill={color} transform="translate(587,650)"/>
    </svg>
  );
}

function SmilingPointingGhostFigure({ size, color = "#5EEAD4", glowColor = "#5EEAD4" }) {
  const H = size === "sm" ? 150 : 190;
  return (
    <svg viewBox={GHOST_VIEWBOX} width="100%" style={{maxHeight:H, display:"block", margin:"0 auto"}}>
      <path d="M0 0 C9.41997952577276 7.39345910769876 12.97393763421428 19.23395377533174 14.5 30.5625 C15.97302769914586 43.13652138032005 15.338185093103448 55.42323261057061 14.3125 68 C13.06961135618144 83.37715958884115 13.06961135618144 83.37715958884115 12.9375 90.1875 C12.909140624999964 91.35667968749999 12.880781249999927 92.52585937499998 12.8515625 93.73046875 C13.907860542312278 101.22302350775732 18.326727793004807 105.36177291810407 23.9375 109.875 C25.194693033476256 110.92105514644095 26.451199540800303 111.96793591874285 27.70703125 113.015625 C28.321430664062518 113.52287109374998 28.935830078125036 114.0301171875 29.56884765625 114.552734375 C44.98297793873178 127.34676466267177 60.45097403721752 142.89168996109387 62.72265625 163.76953125 C63.08588891918134 173.1111304086882 61.795919675850655 179.01952714500848 55.55078125 185.95703125 C43.772677346576074 197.30510296222377 27.49479635063335 197.31323782936647 12.125 197.125 C10.68164689232151 197.11494179019041 9.238286935487395 197.10582100314224 7.794921875 197.09765625 C4.300636064303944 197.0758869136829 0.8066136339975856 197.04151675097523 -2.6875 197 C-3.347500000000082 195.68 -4.007499999999936 194.36 -4.6875 193 C-2.6875 191 -2.6875 191 -0.435302734375 190.820556640625 C0.4933862304687864 190.85012451171872 1.4220751953125728 190.8796923828125 2.37890625 190.91015625 C3.4139428710936954 190.9324731445313 4.4489794921875045 190.95479003906246 5.515380859375 190.977783203125 C6.069718017578111 190.99176147460935 6.069718017578111 190.99176147460935 8.875 191.0625 C39.75264945380525 191.42177310021918 39.75264945380525 191.42177310021918 50.953125 181.5546875 C54.66876338306406 177.47602697606192 56.02974997785873 173.30912518082033 56.6875 167.9375 C54.63075361010203 146.34166290607112 39.01087092121247 130.42946574900594 23.3125 117 C21.317684900519453 115.38939035973061 19.317911914710976 113.78489592674447 17.3125 112.1875 C11.021757759197385 107.09154621356566 8.151313897730688 103.0407783159539 6.3125 95 C6.195468701913342 91.91736067368214 6.392766143658378 88.88647717372649 6.625 85.8125 C6.67333984375 85.03841796875 6.7216796875 84.2643359375 6.771484375 83.466796875 C6.991747977389423 80.0624695519951 7.250160461221981 76.66493527110302 7.568603515625 73.268310546875 C8.277463855174688 65.59643485372118 8.562849328558173 57.948893963499785 8.607666015625 50.246826171875 C8.619177681527162 48.87920783547028 8.639617244554529 47.51163414542785 8.669189453125 46.144287109375 C8.933499918412167 33.825056875347 7.924797646636421 20.222228268340317 0.3125 10 C-4.957430624546646 4.717727617550409 -9.174155767847651 1.7170282437608648 -16.8125 1.625 C-37.293038624259225 1.991542078286514 -53.328683737781375 20.32193411619329 -67.2919921875 33.51611328125 C-84.25301852842404 49.53602873716923 -84.25301852842404 49.53602873716923 -93.6875 51 C-100.05177168521061 50.75696981720759 -106.23516662304826 49.770465564615705 -112.46142578125 48.48828125 C-130.203498865381 44.903638864383 -153.99646800327378 41.31949014653796 -170.12109375 51.54296875 C-175.57787089904684 55.79361333847319 -178.08333152027944 60.313378793024455 -178.9609375 67.12109375 C-179.8018904012531 85.2662698116527 -167.0631121317191 102.50316727225683 -157.79736328125 117.1474609375 C-155.52392237369793 120.94219688261774 -154.39476697333703 123.5885750347312 -154.375 128.0625 C-154.35824218750008 128.9197265625 -154.34148437499994 129.776953125 -154.32421875 130.66015625 C-154.8609226381625 135.59436941536416 -156.29192764409595 140.24723920715388 -157.6875 145 C-156.62015625000004 145.3623876953125 -155.55281250000007 145.724775390625 -154.453125 146.09814453125 C-150.41157056720397 147.4710998764402 -146.37116206871588 148.84740232859966 -142.3310546875 150.224609375 C-140.59763126082328 150.81501070466234 -138.86391703691197 151.40455908903598 -137.1298828125 151.9931640625 C-128.29449825854454 154.992894855442 -119.4695846413274 158.02020364765264 -110.7109375 161.23828125 C-110.06165283203131 161.47221588134767 -109.41236816406251 161.7061505126953 -108.743408203125 161.94717407226563 C-102.76386063582152 164.17655390381108 -98.55684971950018 166.83023308432587 -95.25 172.4375 C-92.25164602257632 186.09666811937447 -102.26937681534605 202.29049357233208 -109.359375 213.6875 C-112.02363596587679 217.42295867380676 -114.45685403107223 220.00219495911745 -118.6875 222 C-119.34750000000008 222.33000000000004 -120.00749999999994 222.65999999999997 -120.6875 223 C-128.16757141711878 223.48913947898666 -134.41113855178344 222.04171968859004 -141.5625 219.9375 C-142.6529663085937 219.62312988281246 -143.74343261718752 219.30875976562504 -144.866943359375 218.98486328125 C-151.72817747174372 216.9697738387021 -158.52353370079254 214.80290816874526 -165.25 212.375 C-165.9916943359375 212.11066162109375 -166.733388671875 211.8463232421875 -167.49755859375 211.573974609375 C-173.83638831152427 209.193101454211 -181.21558821537883 206.12690314933155 -184.6875 200 C-185.70265551947 196.95453344159012 -185.92012216278363 194.69511348865234 -186 191.5 C-186.01869140625 191.02046875000002 -186.01869140625 191.02046875000002 -186.11328125 188.59375 C-184.95138850776243 178.78694887285775 -179.91990086235705 170.37963181207658 -175 162 C-173.82722967728046 159.98044111635912 -172.65655388227015 157.95966403168316 -171.48828125 155.9375 C-170.97434814453118 155.0596484375 -170.46041503906258 154.181796875 -169.930908203125 153.27734375 C-168.6875 151 -168.6875 151 -167.6875 148 C-171.14014342005487 147.67882386790188 -173.2125320055327 147.7512072409933 -176.3125 149.375 C-183.64171768444567 157.47571428280844 -184.44881304201385 169.97903185116485 -186.310546875 180.30078125 C-188.4100319116685 191.2272565089562 -191.79154937942712 199.58366598218026 -199.3125 207.8125 C-200.37796396202452 209.019213665272 -201.44306015402412 210.2262521388285 -202.5078125 211.43359375 C-203.040517578125 212.0302685546875 -203.57322265624998 212.626943359375 -204.1220703125 213.24169921875 C-233.24188398050933 245.94926285521342 -255.3059560504994 282.707279929355 -252.6875 328 C-250.7204345831409 348.04030404558466 -243.20278892018246 365.8908472313079 -233.43115234375 383.28515625 C-220.40648460005127 406.48366186645615 -220.40648460005127 406.48366186645615 -223.30078125 418.55859375 C-228.32572841439492 432.74798199835755 -240.52314274340836 439.62442963513143 -253.4111328125 445.8409118652344 C-262.3695115031261 450.0799362441701 -271.44948364181187 453.68219182860037 -280.77984619140625 457.0139465332031 C-284.95174681394565 458.5059506915036 -289.1119071270623 460.0301433434595 -293.2734375 461.55078125 C-293.68291122436517 461.700118637085 -293.68291122436517 461.700118637085 -295.7550964355469 462.4558563232422 C-327.67020055224214 474.1148416619652 -360.57271946685023 487.11050846007265 -387.6875 508 C-388.6633203125 508.75152343750005 -389.639140625 509.503046875 -390.64453125 510.27734375 C-404.6854318797876 521.4511513840547 -419.2190179422226 535.5998256793085 -422.6875 554 C-423.3806673800436 560.7522657726597 -423.42292327758764 565.2234701038897 -419.6875 571 C-419.6875 571.66 -419.6875 572.32 -419.6875 573 C-418.0244415979649 573.6756174758268 -416.3565539500508 574.3393328114382 -414.6875 575 C-414.0829296875 575.25265625 -413.478359375 575.5053125 -412.85546875 575.765625 C-399.0789610280147 581.3088352076627 -383.10339075061273 579.1884384523557 -368.6875 577.625 C-367.37531494140626 577.4892456054688 -366.0631298828125 577.3534912109375 -364.711181640625 577.213623046875 C-358.163041270201 576.5250523506256 -351.64084602577816 575.7569239807958 -345.125 574.8125 C-326.3603656773944 572.2044589516285 -326.3603656773944 572.2044589516285 -318.6875 577 C-314.11820108850475 581.5692989114953 -311.7323724084075 585.6712831581334 -311.64453125 592.1875 C-311.6587109375 593.115625 -311.67289062500004 594.04375 -311.6875 595 C-307.32980273512726 594.6657699720854 -302.97439557126086 594.3108380145326 -298.619873046875 593.93798828125 C-297.14343326736025 593.814349496016 -295.66653648914166 593.6960323785987 -294.189208984375 593.58349609375 C-272.61785025706956 591.9303502570696 -272.61785025706956 591.9303502570696 -266.0625 585.375 C-261.0435868235264 576.7059681497274 -261.5410820058031 563.044749423947 -263.375 553.375 C-267.3970750769038 549.244220191288 -273.1404113818294 549.4589602565676 -278.6875 549 C-279.375 547.1875 -279.375 547.1875 -279.6875 545 C-278.5439453125 543.3771972656251 -278.5439453125 543.3771972656251 -276.6875 542 C-274.2333984375 541.691162109375 -274.2333984375 541.691162109375 -271.296875 541.77734375 C-270.7511181640625 541.7874145507813 -270.7511181640625 541.7874145507813 -267.9892578125 541.83837890625 C-267.4032177734375 541.8547338867188 -267.4032177734375 541.8547338867188 -264.4375 541.9375 C-255.21773736753914 542.0699180673387 -246.1250785893285 541.9404164577228 -236.9375 541.125 C-236.00518554687505 541.0462866210937 -235.07287109375 540.9675732421875 -234.1123046875 540.886474609375 C-221.35725635593212 539.6697563559322 -221.35725635593212 539.6697563559322 -217.6875 536 C-217.5625 533.625 -217.5625 533.625 -218.6875 531 C-224.57791007693152 527.5975485172062 -230.49547237479192 525.6746632703242 -237.0625 524 C-237.55544555664062 523.8729064941406 -237.55544555664062 523.8729064941406 -240.050048828125 523.229736328125 C-298.92018170100084 508.6401215334612 -298.92018170100084 508.6401215334612 -317.6875 519 C-322.101848027364 522.6466353269528 -323.07572082408 525.9742523796506 -324.625 531.4375 C-326.25608662128525 537.0915038216092 -327.7903709723987 541.4884517555861 -332.6875 545 C-342.606482859311 549.8244780513527 -354.9068951424547 549.2190190603113 -365.6875 549 C-366.34749999999997 547.68 -367.0075 546.36 -367.6875 545 C-365.0992130332113 542.4117130332113 -363.84220510383216 542.6685315049111 -360.234375 542.47265625 C-359.13996093750006 542.40240234375 -358.045546875 542.3321484375 -356.91796875 542.259765625 C-354.61344993929345 542.129150361318 -352.30876075100025 542.0015044205603 -350.00390625 541.876953125 C-339.01679402396894 541.1620823998597 -339.01679402396894 541.1620823998597 -334.6875 538 C-332.1238944643626 534.6253422705659 -331.06294139190993 531.2380272737137 -329.9375 527.1875 C-327.80763879945255 520.6365632771041 -324.8610301662475 515.3496646211551 -318.703125 511.8828125 C-292.5941233883025 501.25705603012307 -248.66052811227667 511.8708340709634 -223.3125 521.40234375 C-218.58265503649352 523.4869413686143 -214.57364251855586 525.6034428967333 -211.6875 530 C-210.8125 533.5 -210.8125 533.5 -211.6875 537 C-214.55116329095972 541.6288065653873 -217.45969464810491 544.3396669697844 -222.6875 546 C-234.87543045586483 548.2412900958501 -247.33220707598457 548.5566799796809 -259.6875 549 C-259.2092578125 549.9010546875 -258.73101562500005 550.802109375 -258.23828125 551.73046875 C-253.60458186815106 561.4997543485077 -255.67711447431543 574.4776233901581 -258.3984375 584.66015625 C-260.77493195593127 590.3179572712309 -265.3046163327707 593.3580939056543 -270.6875 596 C-278.1464740299459 598.8585289695601 -285.75455607731544 599.6927380875017 -293.6875 600 C-294.01911132812506 600.0136157226563 -294.01911132812506 600.0136157226563 -295.697265625 600.08251953125 C-297.8398949026781 600.160585080093 -299.9813409648533 600.2101259360118 -302.125 600.25 C-303.4437109375 600.27578125 -304.762421875 600.3015625 -306.12109375 600.328125 C-310.674753565139 599.9091683466904 -312.9572286662758 598.390396607457 -316.4375 595.59375 C-318.4373017470949 593.044002772454 -318.5611714359196 590.2895535255025 -319.0625 587.15625 C-319.79114396029684 584.642428336976 -320.68288715189556 583.6437825354457 -322.6875 582 C-330.77759311550676 577.9549534422466 -345.13959010178735 581.4640293734241 -353.89483642578125 582.6532287597656 C-357.50350892281483 583.1405266680587 -361.11687603702 583.5899417768774 -364.73046875 584.0390625 C-365.0805700683594 584.0826917266845 -365.0805700683594 584.0826917266845 -366.852294921875 584.3034820556641 C-384.76699048990884 586.5056432901406 -406.13447906571673 589.0748925269503 -421.9296875 578.5234375 C-426.67523602653586 574.4106287770022 -429.2325511005425 569.0497910230398 -429.92578125 562.87890625 C-430.5031849501565 544.8578328714318 -419.7777418795878 529.6938450745452 -407.96875 517.0625 C-391.8124061787336 500.18677428110107 -371.7497252930799 487.82967040005576 -350.6875 478 C-349.91728515625005 477.632294921875 -349.1470703125 477.26458984374995 -348.353515625 476.8857421875 C-328.0088329853278 467.18128016706953 -306.911856271446 459.3204055477729 -285.73583984375 451.6494140625 C-237.79477896753679 434.2824165902683 -237.79477896753679 434.2824165902683 -230.6328125 419.87890625 C-228.05873450965328 413.30703456668107 -228.13818702239848 407.82090353550836 -230.78515625 401.29296875 C-233.22271742681085 396.2209403403128 -236.023359156203 391.40939448195036 -238.9716796875 386.623779296875 C-257.2293199550427 356.960911165336 -264.07420511159955 323.11053988223375 -256.21484375 288.90380859375 C-249.78902543050208 263.3973525987231 -236.66673072831009 241.7784540854442 -219.6875 222 C-218.64048550273276 220.77095215610552 -217.59360807665826 219.54178752791978 -216.546875 218.3125 C-208.81054500139146 209.25869354591208 -208.81054500139146 209.25869354591208 -204.85546875 204.8125 C-203.96587115926854 203.79190602043832 -203.07653549367342 202.77108365746494 -202.1875 201.75 C-201.4140625 200.87859375 -200.640625 200.0071875 -199.84375 199.109375 C-194.76624049540715 191.78745912018854 -193.02814650810683 183.80263921610998 -191.6875 175.125 C-187.84550162469532 152.37793025414877 -187.84550162469532 152.37793025414877 -179.9375 144.1875 C-174.7468042069812 141.44796610924007 -169.25942146814464 141.74631766966743 -163.6875 143 C-163.56375000000003 142.319375 -163.44000000000005 141.63875 -163.3125 140.9375 C-162.6875 137.99999999999994 -162.6875 137.99999999999994 -161.5625 134.75 C-160.34102215758332 129.5150949610714 -160.31141979462018 124.7440877380748 -162.76953125 119.84228515625 C-164.19269952811726 117.64772286531701 -165.69592052387202 115.54128187293611 -167.25 113.4375 C-178.3372419013308 97.63020890896547 -186.7608530476823 81.80756697979945 -184.6875 62 C-182.54679247104195 54.140397478221644 -177.38511383998946 48.46164121956218 -170.6875 44 C-152.20207210552462 35.263736132062974 -129.75974682461094 37.8435334008515 -110.442626953125 42.22119140625 C-102.97225580572638 43.9044694468507 -95.77790854286741 45.49625395629829 -88.3984375 42.796875 C-85.42623922786538 40.826830035760935 -82.90529638278463 38.69832972216028 -80.3125 36.25 C-79.83361328125 35.803339843749995 -79.83361328125 35.803339843749995 -77.41015625 33.54296875 C-76.51167968749996 32.70378906249999 -75.61320312499993 31.864609375 -74.6875 31 C-73.38134985756892 29.846933617173306 -72.06953728361236 28.7002221255363 -70.75 27.5625 C-67.94695878457924 25.135476508599112 -65.22330743759039 22.63753314944171 -62.517822265625 20.102294921875 C-45.809292811177784 4.527913678747794 -23.412004618770652 -14.371208192325753 0 0 Z M-161.6875 150 C-163.120361328125 151.996826171875 -163.120361328125 151.996826171875 -164.76953125 154.79296875 C-165.37007324218757 155.8100390625 -165.97061523437492 156.827109375 -166.58935546875 157.875 C-167.21986816406252 158.968125 -167.85038085937504 160.06125 -168.5 161.1875 C-169.13566894531255 162.2870703125 -169.77133789062498 163.386640625 -170.42626953125 164.51953125 C-182.11120157374899 185.034088983757 -182.11120157374899 185.034088983757 -180.6875 195 C-178.85007332825876 199.49148741981196 -175.87920799086407 201.7817385774843 -171.6875 204 C-167.51841439554323 205.66658371625238 -163.27122956752555 207.05727734499175 -159 208.4375 C-158.40175415039062 208.6330346679688 -158.40175415039062 208.6330346679688 -155.374267578125 209.62255859375 C-148.24642309434853 211.92487955477708 -141.10003451379828 214.14686397714053 -133.875 216.125 C-133.1245239257812 216.33697021484375 -132.37404785156252 216.5489404296875 -131.600830078125 216.767333984375 C-127.30152808778746 217.88856818220052 -123.9852242517195 218.21071582902425 -119.6875 217 C-109.06408831939405 208.449449135122 -103.28152380040024 192.38212883240078 -99.8046875 179.5859375 C-99.64872507357097 176.14436662346583 -100.61006483055962 174.70696097836174 -102.6875 172 C-105.6211912509691 169.50337874848813 -108.46469749065761 168.15629489809962 -112.0703125 166.8359375 C-113.14353759765618 166.4400341796875 -114.21676269531247 166.044130859375 -115.322509765625 165.63623046875 C-116.47420654296877 165.2200244140625 -117.62590332031255 164.803818359375 -118.8125 164.375 C-119.4047839355469 164.15851806640626 -119.4047839355469 164.15851806640626 -122.402099609375 163.06298828125 C-130.9956811205817 159.93712055311997 -139.61473806883168 156.88379783422474 -148.25 153.875 C-149.36713378906256 153.4848974609375 -150.484267578125 153.094794921875 -151.63525390625 152.69287109375 C-152.66440917968748 152.3378955078125 -153.69356445312496 151.982919921875 -154.75390625 151.6171875 C-155.2073742675782 151.46048583984376 -155.2073742675782 151.46048583984376 -157.502197265625 150.66748046875 C-159.6875 150 -159.6875 150 -161.6875 150 Z " fill={color} transform="translate(877.6875,66)"/>
<path d="M0 0 C4.474301391478662 3.6418732256221347 9.418402235252529 9.146914808547848 10.3125 15.0703125 C10.3125 17 10.3125 17 10 20 C8.67999999999995 20.329999999999984 7.360000000000014 20.659999999999997 6 21 C5.599101562499982 20.035781250000014 5.198203124999964 19.0715625 4.78515625 18.078125 C-0.29017926361620994 6.53788724776507 -0.29017926361620994 6.53788724776507 -5.375 4.0625 C-11.913171000098487 2.045640471156048 -17.502587267612853 3.0168182603857474 -23.5625 6 C-30.66217162881867 10.282144601297972 -35.706856255443654 17.023641415095966 -40 24 C-41.32000000000005 23.340000000000003 -42.639999999999986 22.680000000000007 -44 22 C-41.80799754897657 13.231990195906405 -35.36887705196409 6.018459371596208 -28 1 C-18.73372149786826 -3.646846763643026 -9.359324917842287 -5.101346328845892 0 0 Z " fill={color} transform="translate(787,180)"/>
<path d="M0 0 C7.654813181862096 5.300520902730483 11.452241154128501 13.530773923948175 13.22265625 22.5390625 C13.2889013186292 24.287932311809925 13.308182204257378 26.039089976441886 13.28515625 27.7890625 C13.276132812500009 28.681093750000002 13.267109375000018 29.573125000000005 13.2578125 30.4921875 C13.246210937499995 31.167656249999993 13.234609374999991 31.843124999999986 13.22265625 32.5390625 C12.397656249999955 32.70406249999999 12.397656249999955 32.70406249999999 8.22265625 33.5390625 C7.248706150058069 30.617212200174265 7.095456079154701 28.524629687946486 6.97265625 25.4765625 C6.3550135294465235 18.507340160619947 4.271763228904206 12.74453393936085 -0.60546875 7.6171875 C-4.9937549877327 3.989076831008447 -9.050530981243924 2.196524166167876 -14.77734375 2.5390625 C-17.19293458196978 2.9733260203541363 -19.53054559379234 3.5051117944368855 -21.89453125 4.1640625 C-23.77734375 4.5390625 -23.77734375 4.5390625 -25.77734375 3.5390625 C-25.44734374999996 1.8890624999999943 -25.117343750000032 0.23906249999998863 -24.77734375 -1.4609375 C-16.290576987592203 -5.130890694554694 -7.957123441671683 -4.514501096859675 0 0 Z " fill={color} transform="translate(842.77734375,222.4609375)"/>
<path d="M0 0 C1.2601810402791216 0.6510629005341002 2.5112409327280147 1.320004163455394 3.75390625 2.00390625 C4.445085449218709 2.3680664062499943 5.136264648437532 2.7322265624999886 5.848388671875 3.107421875 C7.298627100511567 3.8733755874499707 8.745314205250224 4.646088887570045 10.1884765625 5.42529296875 C12.174364595493103 6.490235679421147 14.173526051704812 7.520676131650674 16.18359375 8.5390625 C24.868394752942322 12.975402639679771 33.32398792669119 17.808868212985942 41.733978271484375 22.7421875 C42.94518383236857 23.45222889800357 44.15775006978686 24.15995484777261 45.371734619140625 24.865234375 C47.092412545102206 25.866891723018284 48.80608660197777 26.88055028080271 50.51953125 27.89453125 C51.516298828124945 28.481376953124993 52.513066406250005 29.068222656249986 53.5400390625 29.6728515625 C57.54341271499948 32.40325659668798 60.760266642697275 34.897987428091824 62.31640625 39.56640625 C63.73886801057142 48.209211883851594 60.03947821396662 54.34919662929525 55.13134765625 61.22705078125 C52.29121734270325 65.08739012979026 49.33275735384609 68.84257501403158 46.31640625 72.56640625 C45.901730957031305 73.09564697265625 45.487055664062495 73.62488769531251 45.059814453125 74.170166015625 C42.52336579771713 77.34503048540546 40.06317325480268 79.71572618415655 36.62890625 81.87890625 C35.86191406249998 82.37003906249998 35.094921874999955 82.86117187499997 34.3046875 83.3671875 C31.26044162917333 85.20330436118621 29.367038518264962 85.77216255839079 25.81640625 85.87890625 C25.419374999999945 85.89759765625001 25.419374999999945 85.89759765625001 23.41015625 85.9921875 C14.774185687533304 84.80365114733729 7.109383165835311 79.98325437379458 -0.24609375 75.56640625 C-1.1941186523437182 75.00115234375 -2.14214355468755 74.43589843749999 -3.118896484375 73.853515625 C-9.301616798458781 70.12094410658392 -15.337045539593987 66.21853328350699 -21.24609375 62.06640625 C-21.58773559570318 61.82664062499998 -21.58773559570318 61.82664062499998 -23.316650390625 60.61328125 C-34.321009413254274 52.698035765355996 -34.321009413254274 52.698035765355996 -35.68359375 46.56640625 C-35.94886424805418 38.24939592865542 -32.94218998019619 31.073246454377966 -29.68359375 23.56640625 C-29.534304199218695 23.215378417968736 -29.534304199218695 23.215378417968736 -28.77880859375 21.43896484375 C-21.297007373338147 3.9865105450917895 -21.297007373338147 3.9865105450917895 -14.68359375 -0.43359375 C-9.347564438380118 -2.212270187206599 -5.153085193236052 -2.005495509986872 0 0 Z M-16.68359375 9.56640625 C-18.357061488047975 12.203684393343622 -19.824436242986508 14.911351446291633 -21.24609375 17.69140625 C-21.635954589843777 18.446232910156255 -22.025815429687555 19.20105957031251 -22.427490234375 19.978759765625 C-31.804547141149442 38.42759237342938 -31.804547141149442 38.42759237342938 -29.68359375 47.56640625 C-26.90482022586525 51.86209478972529 -23.301294474825227 54.47277164048978 -19.05859375 57.19140625 C-18.409792480468695 57.61454101562498 -17.760991210937505 58.037675781250016 -17.092529296875 58.4736328125 C-14.964703648688783 59.85169163570055 -12.826417904303298 61.21179633338892 -10.68359375 62.56640625 C-9.935776367187486 63.03981445312502 -9.187958984374973 63.513222656250036 -8.41748046875 64.0009765625 C18.14511871583943 80.72453189714071 18.14511871583943 80.72453189714071 27.31640625 80.56640625 C40.162596210990955 76.28434292966972 49.39565727352465 61.348458685859896 55.56640625 50.00390625 C56.86972971226237 47.12036276572712 57.32191362174865 45.46910934910653 57.50390625 42.25390625 C55.02696009172314 36.64818599705768 48.85284857078591 33.514544548621075 43.75390625 30.50390625 C43.11751220703127 30.128144531249973 42.481118164062536 29.752382812500002 41.825439453125 29.365234375 C39.65988712572903 28.09177336974352 37.4884317129214 26.82879189309176 35.31640625 25.56640625 C34.506230468750005 25.092192382812527 33.69605468750001 24.617978515624998 32.861328125 24.12939453125 C23.515874802955523 18.667187355035935 14.109193840337184 13.310468911334226 4.50390625 8.31640625 C3.793874511718741 7.9335546875000205 3.083842773437482 7.5507031250000125 2.352294921875 7.15625 C-4.9510298085443765 3.45037005602191 -11.198471962649705 2.3466732991286676 -16.68359375 9.56640625 Z " fill={color} transform="translate(814.68359375,248.43359375)"/>
<path d="M0 0 C3.7426584186176797 0.431845202148196 5.6627520173063886 2.3945435061613125 8.44140625 4.78515625 C12.263001666088826 7.76389352920711 15.891933987629955 8.167567160046303 20.5625 7.75 C23.949388118461343 7.275149132040042 26.900478309777554 6.499768559785025 30 5 C32 7 32 7 32 11 C24.624105836360513 14.278175183839778 17.728395656048633 15.41670921690951 9.875 12.9375 C5.169552121712741 10.959291300148607 1.6227563555023607 7.516771462123359 -2 4 C-1.3400000000000318 2.680000000000007 -0.67999999999995 1.3600000000000136 0 0 Z " fill={color} transform="translate(731,254)"/>
<path d="M0 0 C1.32000000000005 0 2.6399999999999864 0 4 0 C4.371250000000032 1.175625000000025 4.74249999999995 2.351249999999993 5.125 3.5625 C7.177836702716149 9.014137092590488 10.30625474715896 13.480451395833313 15.4375 16.375 C18.606808993409118 17.148002193514458 21.761605569586095 17.619012419951275 25 18 C25.33000000000004 19.319999999999993 25.659999999999968 20.639999999999986 26 22 C19.476810897715723 23.701701504943742 14.833984353199071 22.277519299550022 9 19 C4.425504910169707 15.460110341701409 1.0248669979853275 11.479051876901451 -1 6 C-1.25 3.1875 -1.25 3.1875 -1 1 C-0.6699999999999591 0.6700000000000159 -0.34000000000003183 0.339999999999975 0 0 Z " fill={color} transform="translate(797,277)"/>
<path d="M0 0 C2.125 0.375 2.125 0.375 4 1 C0.4100239204458376 41.88286192089214 -14.773121217393964 78.34777557989776 -42.703125 108.45703125 C-44.21855812483227 110.13483220963582 -45.68092280694566 111.86233188496868 -47.08203125 113.63671875 C-48.771149933773245 115.71801570251085 -50.37565856259209 117.31011659473023 -52.4375 119 C-64.42801288875023 129.30329250102739 -78.82711979788428 141.72243907809172 -80.203125 158.47265625 C-80.61064290696947 180.98802061006336 -66.9014040190782 200.38612690402852 -53 217 C-52.57235351562497 217.51788085937505 -52.144707031249936 218.03576171875 -51.7041015625 218.5693359375 C-45.43729044894167 226.145233917405 -38.87655894916986 233.27353770511672 -31.865234375 240.16650390625 C-28.344630539712057 243.63117841639541 -25.02638608735151 247.17183777485832 -21.8359375 250.9453125 C-19.334885943213635 253.74436168908437 -16.669365866668727 256.36236387085034 -14 259 C-10.14898169557057 262.8145436428232 -6.392056920605228 266.644749330301 -2.8828125 270.78125 C-1.3994922831236636 272.52922901075885 0.11170410292436372 274.25355358786715 1.6328125 275.96875 C34.221028901043155 312.8843253599955 57.70280179005408 359.72207422802717 55 410 C53.42327342536555 428.9842112409008 49.57902039799194 449.9613497101127 34.921875 463.40625 C29.40624857990406 467.9801841044698 24.848679955910256 468.49378641839235 17.8359375 468.27734375 C11.465439110821762 467.6543335769536 8.25681881214723 464.57657698849596 4.296875 459.9140625 C2.804855452529182 457.711985457046 1.9081241550901495 455.4930578219927 1 453 C0.32453125000006366 453.3493359375 -0.35093749999998636 453.69867187499995 -1.046875 454.05859375 C-1.9389062499999454 454.51363281249996 -2.8309375000000045 454.9686718749999 -3.75 455.4375 C-4.6317187500000045 455.88996093750006 -5.513437500000009 456.342421875 -6.421875 456.80859375 C-13.147928028457159 459.91684552830225 -20.590905624240122 459.9182275398098 -27.6875 457.9375 C-35.36215701672177 455.01382113648697 -39.630672767676174 448.98481218215284 -42.93359375 441.703125 C-52.222929120999765 418.1565313123375 -45.284655667109746 393.856689238278 -38.3160400390625 370.73016357421875 C-31.87062033789789 349.2939526317904 -27.019857426305066 327.02907381056025 -34 305 C-34.66000000000008 304.01 -35.319999999999936 303.02 -36 302 C-36.99000000000001 302.3299999999999 -37.98000000000002 302.6600000000001 -39 303 C-41.894380175801416 309.09637563598767 -42.659602419881594 314.82083957745317 -43.125 321.5 C-43.16500122070306 322.013046875 -43.16500122070306 322.013046875 -43.367431640625 324.609375 C-43.95272186504269 332.71579468260154 -44.19259811074278 340.82253725775865 -44.387786865234375 348.9457092285156 C-44.73056943840413 363.1104783586102 -45.70155017418233 377.00436025927 -48 391 C-48.066225585937445 391.4082299804687 -48.066225585937445 391.4082299804687 -48.4013671875 393.47412109375 C-52.21218258344743 415.9745408105 -60.84891971856314 436.4930105565584 -70.58984375 456.9921875 C-82.01316796528522 481.35772668495747 -90.76799272003586 506.5235252523755 -83 533.46875 C-75.48855418524272 554.2240608039347 -60.62698305774609 564.6764363886397 -42.30908203125 575.346435546875 C-27.238233565010205 584.132193673098 -9.970348672322189 595.3300820327579 -5 613 C-4.184802829586488 620.640103713411 -4.142368401270687 627.7525078022009 -9 634 C-15.640368924187669 641.593457169777 -24.173365961932177 644.6713989693428 -34 646 C-48.78081170962332 646.9729141884816 -62.68012985760038 644.5388453426326 -76 638 C-76.91136718749999 637.5578515625 -77.82273437499998 637.115703125 -78.76171875 636.66015625 C-86.96591486695024 632.4351708031825 -94.05209214270519 626.8722757144046 -101.291015625 621.20703125 C-121.16188884205053 605.6882354873463 -141.6944757827414 591.5746299464143 -166 584 C-166.07476562500005 584.6664453125 -166.14953125 585.332890625 -166.2265625 586.01953125 C-168.34828812163892 600.892411833057 -177.01765863846117 611.4768489075459 -188.5625 620.625 C-211.23499341575473 636.8769643068684 -240.75776566224943 645.2431082726088 -268.50390625 641.53125 C-276.1172491273594 639.7523326100189 -281.6503580668409 636.012361452768 -286.4375 629.875 C-288.67567567567573 625.7567567567567 -288.67567567567573 625.7567567567567 -289 623 C-289.14437499999997 621.845 -289.28875000000005 620.69 -289.4375 619.5 C-289.29024339672503 612.3112003673938 -285.4521418166697 605.8144402472408 -280.83203125 600.51171875 C-256.9861259743162 577.988424859917 -223.93591582383613 572.168947857736 -192.3896484375 572.841796875 C-185.13710752547058 573.1802905735735 -178.07951007417682 574.4452840621416 -171 576 C-175.1677737121239 543.7431680405413 -197.70022428068444 521.006052903087 -221.54052734375 500.68701171875 C-223.29857699293257 499.18802168270906 -225.05583986522652 497.6881181887459 -226.8125 496.1875 C-227.41610351562497 495.67195556640627 -228.01970703124994 495.15641113281254 -228.6416015625 494.625244140625 C-233.2774898829025 490.651714261287 -237.8137364981526 486.5863810073288 -242.3046875 482.44921875 C-244.446216086429 480.5032210345057 -246.61181652608172 478.6024666940432 -248.80078125 476.7109375 C-260.22002521773334 466.7378630441427 -270.87560919443 455.8874355442001 -279.81201171875 443.62353515625 C-280.95705599662665 442.0586883728797 -282.13617425657776 440.5189499151187 -283.31640625 438.98046875 C-304.2761760376701 410.58453715939993 -310.1161737033891 376.6566900310503 -305.77734375 342.2265625 C-304.94686116816115 336.93267778683116 -302.9905706938015 332.4401984728579 -300 328 C-299.01 328.3299999999999 -298.02 328.6600000000001 -297 329 C-297.2165625 330.26328125 -297.433125 331.52656249999995 -297.65625 332.828125 C-303.4511294488225 368.9988900243634 -300.15828491137984 403.3601720698673 -279 434 C-274.9159059945804 439.5413413235184 -270.5075592261377 444.8008983214388 -266 450 C-265.59716796875 450.46792968750003 -265.59716796875 450.46792968750003 -263.55859375 452.8359375 C-256.2576640202593 461.116419519062 -248.48198885655097 469.031026820988 -240.08203125 476.19921875 C-237.56846421581668 478.3732420197157 -235.1322377114967 480.623904879513 -232.6875 482.875 C-229.14990051991117 486.1072997989304 -225.55882743824168 489.2005632586993 -221.8125 492.1875 C-214.1601206366813 498.3728996284335 -207.1020614868903 505.1983390250879 -200 512 C-199.462783203125 512.50853515625 -198.92556640625003 513.0170703125 -198.3720703125 513.541015625 C-184.95379725968576 526.2641781393406 -167.57854014411964 545.7351484081954 -166.765625 565.21484375 C-166.22956801469365 574.2321229108463 -166.22956801469365 574.2321229108463 -164 578 C-159.29340832884373 581.56377279968 -153.13704663572867 582.6798703695578 -147.5380859375 584.2177734375 C-129.82358929390045 589.6773008755621 -113.55230475371013 603.1270731057359 -99.427978515625 614.677490234375 C-79.40039677205391 630.9382304988148 -58.299642816897745 641.4192920775231 -32 639 C-24.52130267318489 637.736890730951 -18.361992284819735 635.1280438366532 -13.6875 628.9375 C-10.736498561405824 623.8005715698546 -10.135938279782067 619.479599900337 -11.578125 613.671875 C-17.311140274209947 597.0982490254657 -33.92179675505599 588.2169207754234 -48 579.5 C-68.27470864452039 566.9463363027133 -85.25481463840731 554.171227814212 -91 529.875 C-95.52205780717804 502.09664489876366 -87.97401994301322 478.2641444843671 -76.1875 453.4375 C-68.18583261478466 436.5633870604735 -61.204790989692924 419.6400688238682 -56.5625 401.5 C-56.32724609374998 400.58170410156254 -56.091992187499955 399.6634082031251 -55.849609375 398.71728515625 C-51.96420991738614 382.49257184251974 -51.53573120320334 366.0951502151149 -51 349.5 C-49.66308412186754 308.08684413018614 -49.66308412186754 308.08684413018614 -44 299 C-41.5397333650169 296.8158354322695 -40.3459289656646 296.05888152607054 -37.0625 295.5 C-32.80423245237853 296.1952273547138 -31.589524297627122 297.5706299842236 -29 301 C-21.689744098405072 317.7741556580165 -22.99708160741227 340.75113210913776 -28 358 C-28.214628906250027 358.7405664062501 -28.429257812500055 359.48113281249994 -28.650390625 360.244140625 C-29.88255510156955 364.4633704993141 -31.15453522664484 368.6694656819582 -32.4453125 372.87109375 C-38.98962687730909 394.2966099504947 -46.6694337963072 419.8945325335035 -35.8671875 441.23828125 C-33.26175582416829 445.71995145968526 -30.324461937113483 449.97548028353106 -25.13671875 451.57421875 C-17.39374842426878 453.11715067962473 -11.865361228238271 451.98659816798386 -5.03125 448.09375 C-3 447 -3 447 -1 447 C-1.1443750000000819 446.440546875 -1.2887499999999363 445.88109375 -1.4375 445.3046875 C-4.499594230353523 432.078141588334 -4.75165047079679 414.2183868878544 2.5 402.125 C4.226613716088309 399.6568278289251 5.385087183062524 398.7432752112917 8 397 C11.492840279172015 396.55410549627595 13.29009757908841 396.5267317193923 16.25 398.5 C21.22018146502228 405.6002592357462 20.368959699266725 413.82203160045856 19 422 C17.134778510373735 429.56923907408486 14.899509991422747 436.20719583130494 10.125 442.5 C7.687968008469397 445.7139024517128 7.027068108276808 446.5939783758487 6.75 450.75 C8.52582033049498 455.3671328592868 10.822885229800477 458.4034491685203 14.875 461.375 C19.153640050272315 462.63342354419774 22.794614332920446 462.40179522235985 27 461 C40.03980478252197 452.306796811652 44.028040541684504 436.53974011914374 47 422 C54.45353442551891 381.8006043317009 39.30052984434428 338.65540311771497 16.7109375 305.78125 C12.374606878878467 299.662309742694 7.789930049906729 293.76916037888975 3 288 C2.5298144531250273 287.43216796875004 2.0596289062500546 286.8643359375001 1.5751953125 286.279296875 C-9.404932828395658 273.091248586612 -21.162541676057458 260.6464266248113 -33.4072265625 248.62939453125 C-37.25764970141586 244.83137828148733 -40.89058516190107 240.91665380309234 -44.421142578125 236.819580078125 C-46.42714087620698 234.507734505896 -48.5266999536791 232.29055358275411 -50.625 230.0625 C-67.1719916345213 211.85325349808386 -86.2615464329374 187.46966873591145 -87.4375 161.8125 C-85.1548080666912 141.92047029545176 -73.74624765909357 130.52048811724717 -60 117 C-59.20207031250004 116.19820312500002 -58.40414062499997 115.39640624999998 -57.58203125 114.5703125 C-55.84548708163629 112.84164977264254 -54.08704020150731 111.13474201971593 -52.30859375 109.44921875 C-23.595174162015155 81.82964371774796 -7.278623207333794 44.351247483544284 -2.5234375 5.0625 C-2 2 -2 2 0 0 Z M7.984375 403.6953125 C0.15851900963775734 412.78439721321604 2.71076104011388 428.88729083350404 3 440 C3.660000000000082 440.3299999999999 4.319999999999936 440.65999999999997 5 441 C6.132772681549795 438.8162323438571 7.2562278877690005 436.6284287197857 8.375 434.4375 C8.692109374999973 433.82841796875005 9.009218749999945 433.2193359375 9.3359375 432.591796875 C12.743895860130124 425.88237885349395 14.280485159487739 419.84080471245306 14.25 412.25 C14.252578125000014 411.602890625 14.252578125000014 411.602890625 14.265625 408.328125 C14 405 14 405 12 402 C10 402 10 402 7.984375 403.6953125 Z M-278.1875 606.25 C-282.18066333476486 611.2809904390973 -283.48296801020945 615.3752036158714 -283.3125 621.7890625 C-282.62157729437195 626.6773406423185 -279.87031963754976 629.3188802836568 -276.125 632.25 C-263.5831618866397 639.2734293434818 -244.79524639262297 637.5251353788873 -231.19775390625 633.9814453125 C-210.28390325042665 627.8924090571835 -189.57687785539702 618.5560492948481 -177 600 C-176.590078125 599.42765625 -176.18015624999998 598.8553125 -175.7578125 598.265625 C-172.49192877656742 593.2595258618917 -171.7971363358413 587.8002157068456 -171 582 C-179.64070461202004 580.145921682441 -188.1480409979829 578.4272438734005 -197 578 C-197.84433593749998 577.95875 -198.68867187499995 577.9175 -199.55859375 577.875 C-226.41122139930872 577.2366017200759 -259.48576449212146 585.8620424381323 -278.1875 606.25 Z " fill={color} transform="translate(863,337)"/>
<path d="M0 0 C1.828125 0.15625 1.828125 0.15625 4 1 C5.421875 3.40625 5.421875 3.40625 6.75 6.5 C12.450007526180002 18.438821733939278 19.850846450949803 24.281637549286017 32.20703125 28.80859375 C47.2026238246475 32.966071614864006 64.20930445800866 29.726653762477838 77.8125 22.8125 C86.46012639811954 17.791297575285398 94.27902531238487 11.985887934628181 99.78125 3.53125 C101 2 101 2 104 1 C104.99000000000001 1.660000000000025 105.98000000000002 2.319999999999993 107 3 C104.09583044504666 13.262707278652556 91.71790286532018 22.645712489524954 82.75 27.6875 C64.8173732560623 36.97619767298346 46.579761687210976 39.689648396166035 27 34 C15.189465794625676 29.734155492393143 6.481223264193545 21.184658282340934 1 10 C-0.7488228338854697 6.114370458486178 -1.1859813453941115 4.15093470887922 0 0 Z " fill={color} transform="translate(694,373)"/>
      {/* glow at the fingertip — the "emotion" the figure points to */}
      <circle cx="700" cy="640" r="90" fill={glowColor} opacity="0.18"/>
      <circle cx="700" cy="640" r="55" fill={glowColor} opacity="0.35">
        <animate attributeName="r" values="48;60;48" dur="2.6s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0.3;0.45;0.3" dur="2.6s" repeatCount="indefinite"/>
      </circle>
      <circle cx="700" cy="640" r="22" fill="#A7F3EB" opacity="0.85"/>
    </svg>
  );
}


function TitrationDiagram({ size }) {
  const W = 220, H = size==="sm"?54:66;
  const doses = [8, 13, 18, 24];
  const gap = W / (doses.length + 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{maxHeight:H+10, display:"block", margin:"0 auto"}}>
      {doses.map((r,i) => (
        <circle key={i} cx={gap*(i+1)} cy={H/2} r={r/2} fill="none" stroke="#7F77DD" strokeWidth="2" opacity={0.4 + i*0.15}/>
      ))}
      <text x={W/2} y={H-2} textAnchor="middle" fontSize={size==="sm"?8.5:9.5} fill="#94a3b8" fontFamily="Inter,sans-serif">small doses, building gradually →</text>
    </svg>
  );
}

function PendulationDiagram({ size }) {
  const W = 220, H = size==="sm"?92:112;
  const pivotX = W/2, pivotY = 14;
  const rodLen = size==="sm"?56:72;
  const swingDeg = 32; // degrees off-vertical at each extreme
  const bobR = size==="sm"?9:11;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{maxHeight:H+10, display:"block", margin:"0 auto"}}>
      {/* mounting bar */}
      <line x1={pivotX-26} y1="6" x2={pivotX+26} y2="6" stroke="#475569" strokeWidth="3" strokeLinecap="round"/>
      {/* faint arc showing the full range of motion */}
      <path
        d={`M${pivotX - rodLen*Math.sin(swingDeg*Math.PI/180)},${pivotY + rodLen*Math.cos(swingDeg*Math.PI/180)}
            A${rodLen},${rodLen} 0 0,1 ${pivotX + rodLen*Math.sin(swingDeg*Math.PI/180)},${pivotY + rodLen*Math.cos(swingDeg*Math.PI/180)}`}
        fill="none" stroke="#334155" strokeWidth="1" strokeDasharray="2 4"
      />
      {/* pivot point */}
      <circle cx={pivotX} cy={pivotY} r="3" fill="#94a3b8"/>

      {/* swinging rod + bob — rotate as one group around the pivot */}
      <g transform={`translate(${pivotX},${pivotY})`}>
        <g>
          <animateTransform attributeName="transform" type="rotate"
            values={`${-swingDeg};0;${swingDeg};0;${-swingDeg}`}
            keyTimes="0;0.28;0.5;0.72;1"
            keySplines="0.4 0 0.6 1;0.4 0 0.6 1;0.4 0 0.6 1;0.4 0 0.6 1"
            calcMode="spline"
            dur="4.2s" repeatCount="indefinite"/>
          <line x1="0" y1="0" x2="0" y2={rodLen} stroke="#F0B429" strokeWidth="2"/>
          <circle cx="0" cy={rodLen} r={bobR} fill="#F0B429"/>
          <circle cx={-bobR*0.3} cy={rodLen-bobR*0.3} r={bobR*0.32} fill="#FDE9B0" opacity="0.8"/>
        </g>
      </g>

      <text x={pivotX - rodLen*Math.sin(swingDeg*Math.PI/180) - 14} y={H-4} textAnchor="middle"
        fontSize={size==="sm"?8.5:9.5} fill="#94a3b8" fontFamily="Inter,sans-serif">ease</text>
      <text x={pivotX + rodLen*Math.sin(swingDeg*Math.PI/180) + 20} y={H-4} textAnchor="middle"
        fontSize={size==="sm"?8.5:9.5} fill="#94a3b8" fontFamily="Inter,sans-serif">activation</text>
    </svg>
  );
}

function SomaticDiagram({ practice, size }) {
  switch (practice.diagram) {
    case "arousal": return <FrowningGhostFigure size={size} color="#FCA88B"/>;
    case "body": return <SmilingPointingGhostFigure size={size} color="#5EEAD4" glowColor="#5EEAD4"/>;
    case "dose": return <TitrationDiagram size={size}/>;
    case "pendulum": return <PendulationDiagram size={size}/>;
    default: return null;
  }
}

function SomaticFeed({ fullscreen }) {
  const [active, setActive] = useState(0);
  const [liked, setLiked] = useState({});
  const [dir, setDir] = useState(0);
  const practice = SOMATIC_PRACTICES[active];
  const toggleLike = (id) => setLiked(p => ({...p, [id]: !p[id]}));

  const cardMinHeight = fullscreen ? 520 : 400;

  const goTo = (i) => {
    if (i === active) return;
    setDir(i > active ? 1 : -1);
    setActive(i);
  };
  const next = () => goTo((active + 1) % SOMATIC_PRACTICES.length);
  const prev = () => goTo((active - 1 + SOMATIC_PRACTICES.length) % SOMATIC_PRACTICES.length);

  const touchRef = useRef(null);
  const onTouchStart = (e) => { touchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; };
  const onTouchEnd = (e) => {
    if (!touchRef.current) return;
    const dx = e.changedTouches[0].clientX - touchRef.current.x;
    const dy = e.changedTouches[0].clientY - touchRef.current.y;
    touchRef.current = null;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
    e.stopPropagation();
    if (dx < 0) next(); else prev();
  };

  return (
    <div style={{maxWidth: fullscreen ? 420 : "100%", margin: fullscreen ? "0 auto" : 0}}>
      <style>{`
        @keyframes somBreathe { 0%,100% { transform: scale(1); opacity:0.9; } 50% { transform: scale(1.06); opacity:1; } }
        @keyframes somSlideInR { from { opacity:0; transform: translateX(24px); } to { opacity:1; transform: translateX(0); } }
        @keyframes somSlideInL { from { opacity:0; transform: translateX(-24px); } to { opacity:1; transform: translateX(0); } }
        @keyframes somFadeUp { from { opacity:0; transform: translateY(8px); } to { opacity:1; transform: translateY(0); } }
      `}</style>

      <div
        key={practice.id}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        style={{
          background: practice.bg, borderRadius: 18, padding: fullscreen ? "26px 22px 20px" : "18px 16px 16px",
          border: `1px solid ${practice.color}33`, position:"relative", overflow:"hidden",
          minHeight: cardMinHeight, display:"flex", flexDirection:"column",
          transition:"background 0.3s ease, border-color 0.3s ease",
          animation: `${dir >= 0 ? "somSlideInR" : "somSlideInL"} 0.32s ease`,
          touchAction: "pan-y",
        }}
      >
        <div style={{display:"flex", alignItems:"center", gap:10, marginBottom: fullscreen?14:10, animation:"somFadeUp 0.35s ease"}}>
          <div style={{
            width: fullscreen?34:28, height: fullscreen?34:28, borderRadius:"50%", background:practice.color,
            display:"flex", alignItems:"center", justifyContent:"center", fontSize: fullscreen?16:13, flexShrink:0,
            animation:"somBreathe 3.2s ease-in-out infinite",
          }}>{practice.emoji}</div>
          <div>
            <p style={{margin:0, fontSize: fullscreen?13:12, fontWeight:600, color:"#fff"}}>{practice.title}</p>
            <p style={{margin:0, fontSize: fullscreen?11:10, color:"#94a3b8"}}>{practice.subtitle}</p>
          </div>
        </div>

        <div style={{marginBottom: fullscreen?14:10, animation:"somFadeUp 0.4s ease"}}>
          <SomaticDiagram practice={practice} size={fullscreen?"lg":"sm"}/>
        </div>

        <p style={{fontSize: fullscreen?14:12.5, lineHeight:1.6, color:"#e2e8f0", margin:"0 0 12px", animation:"somFadeUp 0.45s ease"}}>{practice.body}</p>

        {practice.tryIt && (
          <div style={{
            background: "rgba(45,212,191,0.10)", // teal tint — distinct hue from any card's own color
            border: "1px solid rgba(45,212,191,0.35)",
            borderRadius: 10, padding: fullscreen?"11px 13px":"10px 12px",
            marginBottom: 14, animation:"somFadeUp 0.5s ease",
          }}>
            <p style={{margin:0, fontSize: fullscreen?12.5:11.5, lineHeight:1.55, color:"#99f6e4"}}>
              <span style={{fontWeight:700, color:"#5eead4"}}>Try: </span>
              {practice.tryIt}
            </p>
          </div>
        )}

        <div style={{display:"flex", alignItems:"center", gap:14, paddingTop:8, marginTop:"auto", borderTop:"1px solid rgba(255,255,255,0.08)"}}>
          <button onClick={()=>toggleLike(practice.id)} style={{
            background:"none", border:"none", cursor:"pointer", fontSize:18,
            color: liked[practice.id] ? "#D4537E" : "#94a3b8", fontFamily:"inherit"
          }}>♥</button>
          <span style={{fontSize:11, color:"#64748b"}}>Resonates with {liked[practice.id]?1:0} of you</span>
          <span style={{marginLeft:"auto", fontSize:10, color:"#475569"}}>Swipe →</span>
        </div>
      </div>

      <div style={{display:"flex", justifyContent:"center", gap:6, marginTop:12}}>
        {SOMATIC_PRACTICES.map((p,i)=>(
          <button key={p.id} onClick={()=>goTo(i)} style={{
            width: i===active?20:8, height:8, borderRadius:4, border:"none", cursor:"pointer",
            background: i===active ? p.color : "#334155", transition:"all 0.25s ease"
          }}/>
        ))}
      </div>
      <p style={{textAlign:"center", fontSize: fullscreen?11:10, color:"#475569", marginTop:8}}>
        Swipe or tap a dot to explore the next practice →
      </p>
    </div>
  );
}


function LinksPanel({ nodeId }) {
  const l = LINKS[nodeId];
  if (!l) return (
    <div style={{paddingTop:32,textAlign:"center"}}>
      <p style={{color:"#475569",fontSize:13,lineHeight:1.7}}>No links curated yet for this modality.</p>
    </div>
  );

  const LinkCard = ({ item, isResearch }) => {
    const lvl = LEVEL_COLORS[item.level] || LEVEL_COLORS.Beginner;
    return (
      <a href={item.url} target="_blank" rel="noopener noreferrer"
        style={{
          display: "block",
          textDecoration: "none",
          background: "#060812",
          border: "1px solid #1C2040",
          borderRadius: 8,
          padding: "12px 14px",
          marginBottom: 10,
          transition: "border-color 0.15s ease",
        }}
        onMouseEnter={e => e.currentTarget.style.borderColor = lvl.border}
        onMouseLeave={e => e.currentTarget.style.borderColor = "#1C2040"}
      >
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6,flexWrap:"wrap"}}>
          <span style={{
            fontSize:10, fontWeight:600, letterSpacing:".04em", textTransform:"uppercase",
            background:lvl.bg, color:lvl.text, border:`1px solid ${lvl.border}55`,
            borderRadius:20, padding:"2px 8px",
          }}>{item.level}</span>
          <span style={{fontSize:11, color:"#475569"}}>{item.year}</span>
          <span style={{fontSize:11, color:"#334155", marginLeft:"auto"}}>↗</span>
        </div>
        <p style={{fontSize:13.5, fontWeight:600, color:"#e2e8f0", margin:"0 0 4px", lineHeight:1.35}}>{item.title}</p>
        <p style={{fontSize:11.5, color:"#64748b", margin:"0 0 6px"}}>
          {item.source}{item.authors ? ` · ${item.authors}` : ""}
        </p>
        <p style={{fontSize:12.5, color:"#94a3b8", margin:0, lineHeight:1.6}}>
          {isResearch ? item.summary : item.note}
        </p>
      </a>
    );
  };

  return (
    <div>
      {/* Plain language summary */}
      <div style={{
        background:"#0A0C1A", border:"1px solid #1C2040", borderRadius:8,
        padding:"12px 14px", marginBottom:20,
      }}>
        <p style={{fontSize:10.5,fontWeight:600,letterSpacing:".07em",textTransform:"uppercase",color:"#475569",margin:"0 0 7px"}}>
          Before you dive in
        </p>
        <p style={{fontSize:13, lineHeight:1.7, color:"#94a3b8", margin:0}}>{l.plainSummary}</p>
      </div>

      {/* Key resources */}
      <p style={{fontSize:10.5,fontWeight:600,letterSpacing:".07em",textTransform:"uppercase",color:"#475569",margin:"0 0 10px"}}>
        Key resources
      </p>
      <div style={{marginBottom:22}}>
        {l.keyResources.map((item,i) => <LinkCard key={i} item={item} isResearch={false}/>)}
      </div>

      {/* Research & efficacy */}
      <p style={{fontSize:10.5,fontWeight:600,letterSpacing:".07em",textTransform:"uppercase",color:"#475569",margin:"0 0 10px"}}>
        Research &amp; efficacy
      </p>
      <div>
        {l.research.map((item,i) => <LinkCard key={i} item={item} isResearch={true}/>)}
      </div>

      <div style={{marginTop:6, padding:"10px 12px", background:"#060812", borderRadius:8, border:"1px solid #1C2040"}}>
        <p style={{fontSize:11.5, color:"#475569", margin:0, lineHeight:1.6}}>
          Links open in a new tab. Academic papers marked "open access" are free to read in full; others may show an abstract only.
        </p>
      </div>
    </div>
  );
}


function HistoryPanel({ nodeId }) {
  const h = HISTORY[nodeId];
  if (!h) return (
    <div style={{paddingTop:32,textAlign:"center"}}>
      <p style={{color:"#475569",fontSize:13,lineHeight:1.7}}>No history entry yet for this modality.</p>
    </div>
  );
  return (
    <div>
      {/* Header row */}
      <div style={{display:"flex",gap:8,marginBottom:18,flexWrap:"wrap"}}>
        {[{label:"Era", value:h.era},{label:"Origin", value:h.origin}].map(d=>(
          <div key={d.label} style={{flex:1,minWidth:100,background:"#060812",border:"1px solid #1C2040",borderRadius:8,padding:"8px 12px"}}>
            <p style={{fontSize:10,fontWeight:600,letterSpacing:".08em",textTransform:"uppercase",color:"#475569",margin:"0 0 3px"}}>{d.label}</p>
            <p style={{fontSize:13,color:"#e2e8f0",margin:0,fontWeight:500}}>{d.value}</p>
          </div>
        ))}
      </div>

      {/* Founders */}
      <div style={{marginBottom:16}}>
        <p style={{fontSize:10.5,fontWeight:600,letterSpacing:".07em",textTransform:"uppercase",color:"#475569",margin:"0 0 8px"}}>
          {h.founders.length > 1 ? "Founders" : "Founder"}
        </p>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {h.founders.map(f=>(
            <span key={f} style={{fontSize:12.5,background:"#1a2035",border:"1px solid #2a3a5a",borderRadius:20,padding:"4px 12px",color:"#94a3b8"}}>
              {f}
            </span>
          ))}
        </div>
      </div>

      {/* Narrative */}
      <p style={{fontSize:13.5,lineHeight:1.78,color:"#94a3b8",marginBottom:20,whiteSpace:"pre-line"}}>{h.narrative}</p>

      {/* Timeline */}
      <p style={{fontSize:10.5,fontWeight:600,letterSpacing:".07em",textTransform:"uppercase",color:"#475569",margin:"0 0 12px"}}>Timeline</p>
      <div style={{marginBottom:20}}>
        {h.milestones.map((m,i)=>(
          <div key={i} style={{display:"flex",gap:12,marginBottom:14,paddingLeft:4}}>
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",flexShrink:0}}>
              <div style={{width:8,height:8,borderRadius:"50%",background:"#1D9E75",marginTop:4,flexShrink:0}}/>
              {i < h.milestones.length-1 && <div style={{width:1,flex:1,background:"#1C2040",marginTop:4}}/>}
            </div>
            <div style={{paddingBottom:i < h.milestones.length-1 ? 6 : 0}}>
              <span style={{fontSize:11,fontWeight:700,color:"#1D9E75",display:"block",marginBottom:3}}>{m.year}</span>
              <p style={{fontSize:13,lineHeight:1.65,color:"#cbd5e1",margin:0}}>{m.event}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Context box */}
      <div style={{background:"#060812",border:"1px solid #1C2040",borderRadius:8,padding:"12px 14px"}}>
        <p style={{fontSize:10.5,fontWeight:600,letterSpacing:".07em",textTransform:"uppercase",color:"#475569",margin:"0 0 7px"}}>Historical context</p>
        <p style={{fontSize:13,lineHeight:1.72,color:"#94a3b8",margin:0}}>{h.context}</p>
      </div>
    </div>
  );
}

// ── Practice panel ─────────────────────────────────────────────────────────────
function PracticePanel({ nodeId }) {
  const practice = PRACTICES[nodeId];
  if (!practice) return (
    <div style={{paddingTop:32,textAlign:"center"}}>
      <p style={{color:"#475569",fontSize:13,lineHeight:1.7}}>No guided practice yet for this concept.<br/>Check back as the vault grows.</p>
    </div>
  );
  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,paddingBottom:14,borderBottom:"1px solid #1C2040"}}>
        <div>
          <p style={{fontSize:10.5,fontWeight:600,letterSpacing:".07em",textTransform:"uppercase",color:"#378ADD",margin:"0 0 2px"}}>Guided practice</p>
          <p style={{fontSize:15,fontWeight:600,color:"#f1f5f9",margin:0,letterSpacing:"-0.01em"}}>{practice.title}</p>
        </div>
        <span style={{marginLeft:"auto",fontSize:11.5,color:"#475569",background:"#070914",border:"1px solid #1C2040",borderRadius:20,padding:"3px 10px",whiteSpace:"nowrap",flexShrink:0}}>{practice.duration}</span>
      </div>

      <p style={{fontSize:13.5,lineHeight:1.75,color:"#94a3b8",marginBottom:20,whiteSpace:"pre-line"}}>{practice.intro}</p>

      {practice.steps.map((step, i) => (
        <div key={i} style={{marginBottom:20,paddingLeft:14,borderLeft:"2px solid #1C2040",position:"relative"}}>
          <div style={{position:"absolute",left:-7,top:2,width:12,height:12,borderRadius:"50%",background:"#378ADD",border:"2px solid #070914",flexShrink:0}}/>
          <p style={{fontSize:12,fontWeight:600,color:"#378ADD",margin:"0 0 6px",letterSpacing:".02em"}}>{step.heading}</p>
          <p style={{fontSize:13.5,lineHeight:1.78,color:"#cbd5e1",margin:0,whiteSpace:"pre-line"}}>{step.body}</p>
        </div>
      ))}

      <div style={{marginTop:8,padding:"12px 14px",background:"#060812",borderRadius:8,border:"1px solid #1C2040"}}>
        <p style={{fontSize:12,color:"#475569",margin:0,lineHeight:1.6}}>
          <span style={{color:"#378ADD",fontWeight:600}}>Tip: </span>
          You can return to this practice as many times as you like. Each time will feel different — and that's exactly right.
        </p>
      </div>
    </div>
  );
}

// ── Suggest / feedback widget ──────────────────────────────────────────────
// Two visual modes sharing one form + submit flow:
//   "floating" — small pill button, fixed top-right over the canvas, expands
//                into a popover form on click.
//   "inline"   — a small text link/button (used inside the detail panel),
//                opens the same form in a centered modal overlay instead of
//                a popover, since panel space is too tight for an inline form.
// Both submit to POST /api/feedback with { node, feedbackType, feedback }.
const FEEDBACK_TYPES = ["Suggest a new topic", "Suggest a resource", "Something's broken", "Wording or clarity", "This was helpful!"];

function SuggestForm({ nodeLabel, onClose }) {
  const [feedbackType, setFeedbackType] = useState(FEEDBACK_TYPES[0]);
  const [text, setText] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error

  const submit = async () => {
    if (!text.trim() || status === "sending") return;
    setStatus("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node: nodeLabel || "General", feedbackType, feedback: text }),
      });
      if (!res.ok) throw new Error("request failed");
      setStatus("sent");
      setTimeout(() => { onClose(); }, 1400);
    } catch {
      setStatus("error");
    }
  };

  if (status === "sent") {
    return (
      <div style={{padding:"22px 18px",textAlign:"center"}}>
        <div style={{fontSize:24,marginBottom:6}}>✓</div>
        <div style={{fontSize:13,color:"#cbd5e1",fontWeight:600}}>Thanks — sent!</div>
      </div>
    );
  }

  return (
    <div style={{padding:"14px 16px 16px",display:"flex",flexDirection:"column",gap:10}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <span style={{fontSize:13,fontWeight:700,color:"#e2e8f0"}}>Suggest</span>
        <button onClick={onClose} aria-label="Close"
          style={{background:"none",border:"none",color:"#64748b",cursor:"pointer",fontSize:16,lineHeight:1,padding:4}}>✕</button>
      </div>

      <div style={{fontSize:11.5,color:"#64748b"}}>
        {nodeLabel ? <>About <span style={{color:"#cbd5e1",fontWeight:600}}>{nodeLabel}</span></> : "General feedback"}
      </div>

      <select value={feedbackType} onChange={e=>setFeedbackType(e.target.value)}
        style={{background:"#11142A",border:"1px solid #232752",borderRadius:8,color:"#e2e8f0",fontSize:13,padding:"8px 10px",fontFamily:"inherit"}}>
        {FEEDBACK_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
      </select>

      <textarea value={text} onChange={e=>setText(e.target.value)}
        placeholder="What's on your mind?"
        rows={4} maxLength={2000}
        style={{background:"#11142A",border:"1px solid #232752",borderRadius:8,color:"#e2e8f0",fontSize:13,padding:"8px 10px",fontFamily:"inherit",resize:"vertical"}}
      />

      {status === "error" && (
        <div style={{fontSize:11.5,color:"#fb7185"}}>Couldn't send — please try again.</div>
      )}

      <button onClick={submit} disabled={!text.trim() || status==="sending"}
        style={{
          background: text.trim() ? "#7F77DD" : "#2A2D45",
          color: text.trim() ? "#0A0C1A" : "#64748b",
          border:"none", borderRadius:8, padding:"9px 0", fontSize:13, fontWeight:700,
          cursor: text.trim() ? "pointer" : "default",
          fontFamily:"inherit",
        }}>
        {status === "sending" ? "Sending…" : "Send"}
      </button>
    </div>
  );
}

function SuggestWidget({ mode, nodeLabel }) {
  const [open, setOpen] = useState(false);

  if (mode === "inline") {
    return (
      <>
        <button onClick={()=>setOpen(true)}
          style={{background:"none",border:"none",color:"#7F77DD",fontSize:12.5,fontWeight:600,cursor:"pointer",fontFamily:"inherit",padding:"4px 0",textAlign:"left"}}>
          💡 Suggest something for this node
        </button>
        {open && (
          <div style={{position:"fixed",inset:0,background:"rgba(3,4,10,0.6)",backdropFilter:"blur(3px)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}
            onClick={(e)=>{ if(e.target===e.currentTarget) setOpen(false); }}>
            <div style={{background:"#0D1024",border:"1px solid #232752",borderRadius:14,width:"min(360px, 100%)",boxShadow:"0 20px 60px rgba(0,0,0,0.5)"}}>
              <SuggestForm nodeLabel={nodeLabel} onClose={()=>setOpen(false)} />
            </div>
          </div>
        )}
      </>
    );
  }

  // floating mode
  return (
    <div style={{position:"absolute",top:12,right:12,zIndex:30}}>
      {!open && (
        <button onClick={()=>setOpen(true)}
          style={{
            background:"rgba(13,16,36,0.85)",backdropFilter:"blur(6px)",
            border:"1px solid #232752",borderRadius:20,color:"#cbd5e1",
            fontSize:12.5,fontWeight:600,padding:"7px 14px",cursor:"pointer",
            display:"flex",alignItems:"center",gap:6,fontFamily:"inherit",
            boxShadow:"0 2px 10px rgba(0,0,0,0.3)",
          }}>
          💡 Suggest an Idea
        </button>
      )}
      {open && (
        <div style={{background:"#0D1024",border:"1px solid #232752",borderRadius:14,width:280,boxShadow:"0 12px 40px rgba(0,0,0,0.45)"}}>
          <SuggestForm nodeLabel={nodeLabel} onClose={()=>setOpen(false)} />
        </div>
      )}
    </div>
  );
}

// ── Compute gathered cluster positions ────────────────────────────────────────
// When a node is selected, pull connected nodes toward the cluster centroid
// so they're compact and readable on screen. Returns {id: {x,y}} targets.
function computeGatheredPositions(selectedId, nodes, edges) {
  const cluster = new Set([selectedId]);
  edges.forEach(([a,b]) => { if(a===selectedId) cluster.add(b); if(b===selectedId) cluster.add(a); });

  const clusterNodes = nodes.filter(n => cluster.has(n.id));
  // Centroid of cluster, using the collision-resolved base positions —
  // gathering should start from the already-valid passive layout, not the
  // raw hand-placed coordinates (which may overlap before resolution).
  const cx = clusterNodes.reduce((s,n)=>s+basePos(n.id).x,0) / clusterNodes.length;
  const cy = clusterNodes.reduce((s,n)=>s+basePos(n.id).y,0) / clusterNodes.length;

  // Target positions: pull each cluster node 38% of the way toward centroid
  // Selected node stays put; neighbors gather around it
  const PULL = 0.38;
  const positions = {};
  nodes.forEach(n => {
    const p = basePos(n.id);
    if (!cluster.has(n.id)) {
      positions[n.id] = { x: p.x, y: p.y }; // non-cluster stay
    } else if (n.id === selectedId) {
      positions[n.id] = { x: p.x, y: p.y }; // selected stays
    } else {
      positions[n.id] = {
        x: p.x + (cx - p.x) * PULL,
        y: p.y + (cy - p.y) * PULL,
      };
    }
  });

  // Resolve any overlaps introduced by gathering — only among the cluster
  // nodes (non-cluster nodes are untouched and already non-overlapping in
  // the base layout). The selected node is pinned and never moved.
  resolveCollisions(positions, clusterNodes, selectedId);

  return positions;
}

// ── Collision resolver ──────────────────────────────────────────────────────
// Generic pairwise repulsion pass: given a set of {x,y} positions and the
// nodes' radii, nudge any overlapping pair apart along the line between their
// centers until they clear a minimum gap. Runs several iterations since
// resolving one pair can reintroduce a small overlap with a third node.
function resolveCollisions(positions, nodesSubset, pinnedId, opts = {}) {
  const { iterations = 12, gap = 26, getRadius = (n) => RADIUS_LOOKUP[n.id] ?? 24 } = opts;

  for (let iter = 0; iter < iterations; iter++) {
    let movedAny = false;
    for (let i = 0; i < nodesSubset.length; i++) {
      for (let j = i + 1; j < nodesSubset.length; j++) {
        const A = nodesSubset[i], B = nodesSubset[j];
        const pa = positions[A.id], pb = positions[B.id];
        if (!pa || !pb) continue;

        const dx = pb.x - pa.x, dy = pb.y - pa.y;
        let dist = Math.hypot(dx, dy);
        const minDist = getRadius(A) + getRadius(B) + gap;

        if (dist < minDist) {
          movedAny = true;
          // If exactly stacked (dist ~0), nudge apart along a stable pseudo-random axis
          // derived from node ids so it's deterministic, not jittery between renders.
          if (dist < 0.5) {
            const seed = (A.id.charCodeAt(0) + B.id.charCodeAt(0)) % 360;
            const rad = (seed * Math.PI) / 180;
            dist = 0.5;
            positions[B.id] = { x: pa.x + Math.cos(rad) * minDist, y: pa.y + Math.sin(rad) * minDist };
            continue;
          }
          const overlap = minDist - dist;
          const ux = dx / dist, uy = dy / dist;
          const aIsPinned = A.id === pinnedId;
          const bIsPinned = B.id === pinnedId;

          if (aIsPinned && bIsPinned) {
            continue; // both pinned, nothing we can do (shouldn't happen)
          } else if (aIsPinned) {
            // Only B moves, full overlap distance
            positions[B.id] = { x: pb.x + ux * overlap, y: pb.y + uy * overlap };
          } else if (bIsPinned) {
            positions[A.id] = { x: pa.x - ux * overlap, y: pa.y - uy * overlap };
          } else {
            // Split the correction between both
            positions[A.id] = { x: pa.x - ux * overlap * 0.5, y: pa.y - uy * overlap * 0.5 };
            positions[B.id] = { x: pb.x + ux * overlap * 0.5, y: pb.y + uy * overlap * 0.5 };
          }
        }
      }
    }
    if (!movedAny) break;
  }
}

// ── Compute base sizes (full-map, module-level) ────────────────────────────────
const { sizes: NODE_SIZES, degree: NODE_DEGREE } = computeNodeSizes(NODES, EDGES);

// Stable radius-per-node lookup, used by the collision resolver. Uses each
// node's full-map size since that's the conservative (usually larger) case —
// cluster-relative sizes during selection are handled by re-deriving this
// per-call where needed.
const RADIUS_LOOKUP = NODE_SIZES;

// ── Base layout collision fix ────────────────────────────────────────────────
// The hand-placed coordinates in NODES can overlap (e.g. two challenge nodes
// originally only 50px apart with 26px+ radii). Resolve that once at module
// load so the *passive*, nothing-selected map never shows overlapping nodes.
const BASE_POSITIONS = (() => {
  const positions = {};
  NODES.forEach(n => { positions[n.id] = { x: n.x, y: n.y }; });
  resolveCollisions(positions, NODES, null, { gap: 24 });
  return positions;
})();
function basePos(id) {
  return BASE_POSITIONS[id] || { x: 0, y: 0 };
}

// ── Compute initial viewBox from actual screen size ────────────────────────────
// Done at module level so first render is already correct, no flash/jump.
function getInitialViewBox() {
  const W = typeof window !== "undefined" ? window.innerWidth  : 900;
  const H = typeof window !== "undefined" ? window.innerHeight - 80 : 630; // minus header ~80px
  const allX = NODES.map(n => n.x);
  const allY = NODES.map(n => n.y);
  const minX = Math.min(...allX) - 50;
  const maxX = Math.max(...allX) + 50;
  const minY = Math.min(...allY) - 50;
  const maxY = Math.max(...allY) + 50;
  const contentW = maxX - minX;
  const contentH = maxY - minY;
  // Scale so all content fills the screen with padding
  const scale = Math.max(contentW / W, contentH / H);
  const vw = W * scale;
  const vh = H * scale;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return `${cx - vw/2} ${cy - vh/2} ${vw} ${vh}`;
}
const INITIAL_VIEWBOX = getInitialViewBox();

// Singleton animator — lives outside React
const animator = new NodeAnimator();
const edgeWave = new EdgeWaveAnimator();

// ── Main ───────────────────────────────────────────────────────────────────────
export default function MentalMap() {
  const [selected, setSelected]   = useState(null);
  const [breadcrumb, setBreadcrumb] = useState([]);
  const [tab, setTab]             = useState("overview");
  const [overviewFullscreen, setOverviewFullscreen] = useState(false);
  const [insight, setInsight]     = useState("");
  const [loading, setLoading]     = useState(false);
  const insightCache = useRef({});
  const [tooltip, setTooltip]     = useState(null);

  // ── Panel manual scroll ────────────────────────────────────────────────────
  const panelBodyRef    = useRef(null);
  const panelContentRef = useRef(null);
  const [panelScrollY, setPanelScrollY]         = useState(0);
  const [panelMaxScroll, setPanelMaxScroll]     = useState(0);
  const [panelScrollThumb, setPanelScrollThumb] = useState(1);
  const [panelScrolling, setPanelScrolling]     = useState(false);
  const panelTouchRef   = useRef(null);
  const panelScrollTimer = useRef(null);
  const panelRafRef     = useRef(null);

  const clampScroll = (y, max) => Math.min(0, Math.max(-max, y));

  // Remeasure whenever content changes
  useEffect(() => {
    setPanelScrollY(0);
    const measure = () => {
      if (!panelBodyRef.current || !panelContentRef.current) return;
      const bodyH    = panelBodyRef.current.offsetHeight;
      const contentH = panelContentRef.current.scrollHeight || panelContentRef.current.offsetHeight;
      const max = Math.max(0, contentH - bodyH);
      setPanelMaxScroll(max);
      setPanelScrollThumb(max > 0 ? Math.min(1, bodyH / contentH) : 1);
    };
    // Two frames: first lets React render, second lets images/fonts settle
    requestAnimationFrame(() => requestAnimationFrame(measure));
  }, [tab, selected, insight, loading]);

  const onPanelTouchStart = useCallback((e) => {
    if (e.touches.length !== 1) return;
    cancelAnimationFrame(panelRafRef.current);
    const touch = e.touches[0];
    panelTouchRef.current = {
      startY: touch.clientY,
      startScrollY: panelScrollY,
      lastY: touch.clientY,
      lastT: Date.now(),
      vel: 0,
    };
    setPanelScrolling(true);
    clearTimeout(panelScrollTimer.current);
  }, [panelScrollY]);

  const onPanelTouchMove = useCallback((e) => {
    if (!panelTouchRef.current || e.touches.length !== 1) return;
    e.stopPropagation();
    const touch = e.touches[0];
    const ref   = panelTouchRef.current;
    const now   = Date.now();
    const dy    = touch.clientY - ref.startY;
    ref.vel     = (touch.clientY - ref.lastY) / Math.max(1, now - ref.lastT);
    ref.lastY   = touch.clientY;
    ref.lastT   = now;
    setPanelScrollY(clampScroll(ref.startScrollY + dy, panelMaxScroll));
  }, [panelMaxScroll]);

  const onPanelTouchEnd = useCallback(() => {
    if (!panelTouchRef.current) return;
    let vel = panelTouchRef.current.vel * 16;
    const momentum = () => {
      vel *= 0.92;
      if (Math.abs(vel) < 0.5) { setPanelScrolling(false); return; }
      setPanelScrollY(prev => {
        const next = clampScroll(prev + vel, panelMaxScroll);
        if (next === prev) { setPanelScrolling(false); return prev; }
        return next;
      });
      panelRafRef.current = requestAnimationFrame(momentum);
    };
    panelRafRef.current = requestAnimationFrame(momentum);
    panelScrollTimer.current = setTimeout(() => setPanelScrolling(false), 1200);
  }, [panelMaxScroll]);

  const onPanelWheel = useCallback((e) => {
    e.stopPropagation();
    setPanelScrollY(prev => clampScroll(prev - e.deltaY * 0.8, panelMaxScroll));
    setPanelScrolling(true);
    clearTimeout(panelScrollTimer.current);
    panelScrollTimer.current = setTimeout(() => setPanelScrolling(false), 600);
  }, [panelMaxScroll]);
  // Animated node state (updated by animator outside React render)
  const [animState, setAnimState] = useState(null);
  const [edgeWaveTick, setEdgeWaveTick] = useState(0); // bumps on every edge-wave frame
  const svgRef = useRef(null);
  const selectedRef = useRef(null);
  const selectNodeRef = useRef(null); // always points to the latest selectNode — avoids stale closures in touch/mouse handlers that were memoized once with an empty/stable dep array
  const selectionTimersRef = useRef([]); // tracks setTimeout ids from the click sequence so a rapid re-click/deselect can cancel stale ones

  // Init animator once
  useEffect(() => {
    animator.init(NODES, NODE_SIZES, basePos);
    const unsub = animator.subscribe(state => setAnimState({...state}));
    const unsubEdge = edgeWave.subscribe(() => setEdgeWaveTick(t => t + 1));
    return () => { unsub(); unsubEdge(); animator.destroy(); edgeWave.destroy(); };
  }, []);

  // ── Draggable panel width ──────────────────────────────────────────────────
  const DEFAULT_PANEL_W = 340;
  const MIN_PANEL_W = 180;
  const MAX_PANEL_W = 560;
  const COLLAPSE_THRESHOLD = 100;
  const [panelWidth, setPanelWidth]         = useState(DEFAULT_PANEL_W);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const dragRef = useRef(null);
  const preDragWidthRef = useRef(DEFAULT_PANEL_W);

  const onDividerMouseDown = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation(); // never let this gesture reach a node or the background deselect handler
    preDragWidthRef.current = panelWidth;
    dragRef.current = { startX: e.clientX, startW: panelWidth, moved: false };
    const onMove = (ev) => {
      const dx = dragRef.current.startX - ev.clientX;
      if (Math.abs(dx) > 4) dragRef.current.moved = true;
      if (!dragRef.current.moved) return;
      const raw = dragRef.current.startW + dx;
      if (raw < -COLLAPSE_THRESHOLD) {
        setPanelCollapsed(true);
        setPanelWidth(DEFAULT_PANEL_W);
      } else {
        setPanelCollapsed(false);
        setPanelWidth(Math.min(MAX_PANEL_W, Math.max(MIN_PANEL_W, raw)));
      }
    };
    const onUp = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      // If barely moved = tap → toggle collapse
      if (!dragRef.current.moved) {
        setPanelCollapsed(prev => !prev);
      }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [panelWidth]);

  const onDividerTouchStart = useCallback((e) => {
    // preventDefault on BOTH touchstart and touchend (below) — suppresses the
    // browser's deferred synthetic click entirely, so there's no stray event
    // left to land on a node or the canvas after the panel's width-driven
    // layout shift moves everything under the original touch point.
    e.preventDefault();
    e.stopPropagation(); // never let this gesture reach a node or the background deselect handler
    preDragWidthRef.current = panelWidth;
    dragRef.current = { startX: e.touches[0].clientX, startW: panelWidth, moved: false };
    const onMove = (ev) => {
      ev.preventDefault();
      const dx = dragRef.current.startX - ev.touches[0].clientX;
      if (Math.abs(dx) > 6) dragRef.current.moved = true;
      if (!dragRef.current.moved) return;
      const raw = dragRef.current.startW + dx;
      if (raw < -COLLAPSE_THRESHOLD) {
        setPanelCollapsed(true);
        setPanelWidth(DEFAULT_PANEL_W);
      } else {
        setPanelCollapsed(false);
        setPanelWidth(Math.min(MAX_PANEL_W, Math.max(MIN_PANEL_W, raw)));
      }
    };
    const onEnd = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      // If barely moved = tap → toggle collapse
      if (!dragRef.current.moved) {
        setPanelCollapsed(prev => !prev);
      }
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
    };
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd, { passive: false });
  }, [panelWidth]);
  const [viewBox, setViewBox] = useState(INITIAL_VIEWBOX);
  const viewBoxRef = useRef(INITIAL_VIEWBOX.split(" ").map(Number));
  const isPinching = useRef(false);
  const lastPinchDist = useRef(null);
  const lastPinchMid = useRef(null);

  // Re-fit when window resizes (rotation etc.)
  useEffect(() => {
    const fit = () => {
      const el = svgRef.current;
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      const allX = NODES.map(n => n.x);
      const allY = NODES.map(n => n.y);
      const minX = Math.min(...allX) - 50, maxX = Math.max(...allX) + 50;
      const minY = Math.min(...allY) - 50, maxY = Math.max(...allY) + 50;
      const scale = Math.max((maxX-minX)/width, (maxY-minY)/height);
      const vw = width * scale, vh = height * scale;
      const cx = (minX+maxX)/2, cy = (minY+maxY)/2;
      const vb = [cx-vw/2, cy-vh/2, vw, vh];
      viewBoxRef.current = vb;
      setViewBox(`${vb[0]} ${vb[1]} ${vb[2]} ${vb[3]}`);
    };
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const applyViewBox = useCallback((vb) => {
    const el = svgRef.current;
    const rect = el ? el.getBoundingClientRect() : { width:390, height:700 };
    // Clamp zoom: min 0.2× canvas size, max 4× canvas size
    const minW = rect.width * 0.15, maxW = rect.width * 6;
    const minH = rect.height * 0.15, maxH = rect.height * 6;
    vb[2] = Math.min(Math.max(vb[2], minW), maxW);
    vb[3] = Math.min(Math.max(vb[3], minH), maxH);
    viewBoxRef.current = [...vb];
    setViewBox(`${vb[0]} ${vb[1]} ${vb[2]} ${vb[3]}`);
  }, []);

  // Convert a screen-pixel delta into SVG-coordinate delta, accounting for
  // the current zoom level (viewBox width/height vs actual rendered size).
  // Declared up here (rather than down by the node-drag code that originally
  // needed it) because the pan/pinch touch handlers below also depend on it.
  const screenDeltaToSvg = useCallback((dxPx, dyPx) => {
    const el = svgRef.current;
    if (!el) return { dx: dxPx, dy: dyPx };
    const rect = el.getBoundingClientRect();
    const vb = viewBoxRef.current;
    return {
      dx: dxPx * (vb[2] / rect.width),
      dy: dyPx * (vb[3] / rect.height),
    };
  }, []);

  // Scroll wheel zoom
  const onWheel = useCallback((e) => {
    e.preventDefault();
    const vb = [...viewBoxRef.current];
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    // Mouse position in SVG coords
    const mx = vb[0] + (e.clientX - rect.left) / rect.width  * vb[2];
    const my = vb[1] + (e.clientY - rect.top)  / rect.height * vb[3];
    vb[2] *= factor; vb[3] *= factor;
    vb[0] = mx - (e.clientX - rect.left) / rect.width  * vb[2];
    vb[1] = my - (e.clientY - rect.top)  / rect.height * vb[3];
    applyViewBox(vb);
  }, [applyViewBox]);

  // Pinch zoom (mobile)
  const PINCH_END_COOLDOWN_MS = 500; // window after a pinch ends during which a node tap is ignored
  const pinchJustEndedRef = useRef(false);
  // Single-finger pan — only active when the touch starts on empty canvas
  // (node/divider touch handlers call stopPropagation, so this only ever
  // sees touches that begin on the background).
  const PAN_DRAG_THRESHOLD = 6; // px before a touch/click counts as a pan instead of a tap
  const panTouchRef = useRef(null); // { startClientX, startClientY, startVb, moved }
  const onTouchStart = useCallback((e) => {
    if (e.touches.length === 2) {
      isPinching.current = true;
      panTouchRef.current = null; // a second finger landed — hand off to pinch, cancel any pan
      const t = e.touches;
      lastPinchDist.current = Math.hypot(t[0].clientX-t[1].clientX, t[0].clientY-t[1].clientY);
      lastPinchMid.current = { x:(t[0].clientX+t[1].clientX)/2, y:(t[0].clientY+t[1].clientY)/2 };
    } else if (isPinching.current) {
      // A pinch (2 fingers) is collapsing to fewer fingers — one finger just
      // lifted off, but the other may still be resting on a node. Mark a brief
      // cooldown so that finger's eventual lift-off isn't read as a tap-to-select.
      isPinching.current = false;
      pinchJustEndedRef.current = true;
      setTimeout(() => { pinchJustEndedRef.current = false; }, PINCH_END_COOLDOWN_MS);
    } else if (e.touches.length === 1) {
      // Potential single-finger pan — recorded here but only "armed" once the
      // finger moves past the threshold, so a plain tap-to-deselect still works.
      const t = e.touches[0];
      panTouchRef.current = {
        startClientX: t.clientX, startClientY: t.clientY,
        startVb: [...viewBoxRef.current], moved: false,
      };
    }
  }, []);

  const onTouchMove = useCallback((e) => {
    if (isPinching.current && e.touches.length === 2) {
      e.preventDefault();
      const t = e.touches;
      const dist = Math.hypot(t[0].clientX-t[1].clientX, t[0].clientY-t[1].clientY);
      const mid  = { x:(t[0].clientX+t[1].clientX)/2, y:(t[0].clientY+t[1].clientY)/2 };
      const factor = lastPinchDist.current / dist;
      const vb = [...viewBoxRef.current];
      const svg = svgRef.current;
      const rect = svg.getBoundingClientRect();
      const mx = vb[0] + (mid.x - rect.left) / rect.width  * vb[2];
      const my = vb[1] + (mid.y - rect.top)  / rect.height * vb[3];
      vb[2] *= factor; vb[3] *= factor;
      vb[0] = mx - (mid.x - rect.left) / rect.width  * vb[2];
      vb[1] = my - (mid.y - rect.top)  / rect.height * vb[3];
      applyViewBox(vb);
      lastPinchDist.current = dist;
      lastPinchMid.current  = mid;
      return;
    }
    const pan = panTouchRef.current;
    if (pan && e.touches.length === 1) {
      const t = e.touches[0];
      const dxPx = t.clientX - pan.startClientX;
      const dyPx = t.clientY - pan.startClientY;
      if (!pan.moved && Math.hypot(dxPx, dyPx) > PAN_DRAG_THRESHOLD) pan.moved = true;
      if (!pan.moved) return;
      e.preventDefault();
      const { dx, dy } = screenDeltaToSvg(dxPx, dyPx);
      const vb = [pan.startVb[0] - dx, pan.startVb[1] - dy, pan.startVb[2], pan.startVb[3]];
      applyViewBox(vb);
    }
  }, [applyViewBox, screenDeltaToSvg]);

  const canvasJustPannedTouchRef = useRef(false); // stays true through the synthetic click that follows a touch-pan
  const onTouchEnd = useCallback((e) => {
    if (isPinching.current) {
      pinchJustEndedRef.current = true;
      setTimeout(() => { pinchJustEndedRef.current = false; }, PINCH_END_COOLDOWN_MS);
    }
    isPinching.current = false;
    if (panTouchRef.current?.moved) {
      canvasJustPannedTouchRef.current = true;
      setTimeout(() => { canvasJustPannedTouchRef.current = false; }, 350);
    }
    if (e.touches.length === 0) panTouchRef.current = null;
  }, []);

  // Attach wheel listener as non-passive so we can preventDefault
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  // Keep viewBoxRef in sync when viewBox changes externally (cluster recentering)
  useEffect(() => {
    const parts = viewBox.split(" ").map(Number);
    if (parts.length === 4) viewBoxRef.current = parts;
  }, [viewBox]);

  const recenterCluster = useCallback((id) => {
    const cluster = new Set([id]);
    EDGES.forEach(([a,b]) => { if(a===id) cluster.add(b); if(b===id) cluster.add(a); });
    const clusterNodes = NODES.filter(n => cluster.has(n.id));
    if (!clusterNodes.length) return;

    // Use gathered positions if animator has them
    const getPos = (n) => {
      const a = animator.current?.[n.id];
      return { x: a?.x ?? n.x, y: a?.y ?? n.y };
    };
    const positions = clusterNodes.map(getPos);
    const xs = positions.map(p=>p.x), ys = positions.map(p=>p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = (minX+maxX)/2, cy = (minY+maxY)/2;

    const el = svgRef.current;
    const rect = el ? el.getBoundingClientRect() : { width:390, height:700 };
    const aspect = rect.width / rect.height;

    const padX = 70, padY = 70;
    const spanX = Math.max(maxX - minX + padX*2, 200);
    const spanY = Math.max(maxY - minY + padY*2, 200);
    // Fit span to canvas, then expand to fill aspect ratio
    let vw = spanX, vh = spanY;
    if (vw / vh > aspect) { vh = vw / aspect; } else { vw = vh * aspect; }
    // Don't zoom in too aggressively
    const maxZoom = 1.8;
    const curVw = viewBoxRef.current[2];
    const minVw = curVw / maxZoom;
    if (vw < minVw) { vw = minVw; vh = vw / aspect; }

    const vx = cx - vw/2, vy = cy - vh/2;
    const vb = [vx, vy, vw, vh];
    viewBoxRef.current = vb;
    setViewBox(`${vx} ${vy} ${vw} ${vh}`);
  }, []);

  // NOTE: panel collapse/expand is intentionally pure layout (CSS flex width
  // change) and does NOT re-run recenterCluster/selectNode. Re-triggering the
  // selection sequence on every toggle caused the node to visually "reselect"
  // (shrink/resize again) and made repeated toggles drift the map. The cluster
  // viewBox stays exactly as it was; only the panel's width changes.

  const resetViewBox = useCallback(() => {
    const fresh = getInitialViewBox();
    const parts = fresh.split(" ").map(Number);
    viewBoxRef.current = parts;
    setViewBox(fresh);
  }, []);

  // ── Draggable nodes ─────────────────────────────────────────────────────────
  // Lets the user manually reposition any node via mouse or touch. A small
  // movement threshold distinguishes a drag from a normal tap/click so both
  // gestures keep working on the same node.
  const dragNodeRef = useRef(null); // { id, startClientX, startClientY, startX, startY, moved }
  const DRAG_THRESHOLD = 5; // px on screen before a press counts as a drag

  // Click-and-drag panning on empty canvas (desktop). A movement threshold
  // keeps a plain click still working for deselect — same pattern as node drag.
  const canvasPanRef = useRef(null); // { startClientX, startClientY, startVb, moved }
  const canvasJustPannedRef = useRef(false); // stays true through the click that follows a drag
  const onCanvasMouseDown = useCallback((e) => {
    canvasPanRef.current = {
      startClientX: e.clientX, startClientY: e.clientY,
      startVb: [...viewBoxRef.current], moved: false,
    };
    const onMove = (ev) => {
      const pan = canvasPanRef.current;
      if (!pan) return;
      const dxPx = ev.clientX - pan.startClientX;
      const dyPx = ev.clientY - pan.startClientY;
      if (!pan.moved && Math.hypot(dxPx, dyPx) > DRAG_THRESHOLD) pan.moved = true;
      if (!pan.moved) return;
      const { dx, dy } = screenDeltaToSvg(dxPx, dyPx);
      applyViewBox([pan.startVb[0] - dx, pan.startVb[1] - dy, pan.startVb[2], pan.startVb[3]]);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // If this was a drag, swallow the click that the browser fires right
      // after mouseup so it doesn't get read as a deselect tap.
      if (canvasPanRef.current?.moved) {
        canvasJustPannedRef.current = true;
        setTimeout(() => { canvasJustPannedRef.current = false; }, 0);
      }
      canvasPanRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [screenDeltaToSvg, applyViewBox]);

  const onNodeMouseDown = useCallback((e, id) => {
    e.stopPropagation();
    const node = animator.current[id] || basePos(id);
    dragNodeRef.current = {
      id, startClientX: e.clientX, startClientY: e.clientY,
      startX: node.x, startY: node.y, moved: false,
    };
    const onMove = (ev) => {
      const drag = dragNodeRef.current;
      if (!drag) return;
      const dxPx = ev.clientX - drag.startClientX;
      const dyPx = ev.clientY - drag.startClientY;
      if (!drag.moved && Math.hypot(dxPx, dyPx) > DRAG_THRESHOLD) drag.moved = true;
      if (!drag.moved) return;
      const { dx, dy } = screenDeltaToSvg(dxPx, dyPx);
      const newX = drag.startX + dx, newY = drag.startY + dy;
      animator.targets[drag.id] = { ...animator.targets[drag.id], x: newX, y: newY };
      animator.current[drag.id] = { ...animator.current[drag.id], x: newX, y: newY };
      animator.notify();
    };
    const onUp = () => {
      const drag = dragNodeRef.current;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (drag && drag.moved) {
        // Persist the new position so it survives deselect/reselect/recentering
        BASE_POSITIONS[drag.id] = { x: animator.current[drag.id].x, y: animator.current[drag.id].y };
      } else if (drag) {
        // Treated as a normal click, not a drag — always call the LATEST selectNode via ref
        selectNodeRef.current && selectNodeRef.current(drag.id);
      }
      dragNodeRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [screenDeltaToSvg]);

  const onNodeTouchStart = useCallback((e, id) => {
    if (e.touches.length !== 1) return; // let pinch-zoom own multi-touch
    if (isPinching.current || pinchJustEndedRef.current) return; // a pinch is wrapping up — don't treat the lifting finger as a tap on whatever node it happens to rest over
    e.stopPropagation();
    e.preventDefault(); // suppress the synthetic mousedown/click mobile browsers fire after touch — without this, every tap double-toggles selection (once from touchend, once from the synthetic mouseup)
    const touch = e.touches[0];
    const node = animator.current[id] || basePos(id);
    dragNodeRef.current = {
      id, startClientX: touch.clientX, startClientY: touch.clientY,
      startX: node.x, startY: node.y, moved: false,
    };
    const onMove = (ev) => {
      const drag = dragNodeRef.current;
      if (!drag || ev.touches.length !== 1) return;
      const t = ev.touches[0];
      const dxPx = t.clientX - drag.startClientX;
      const dyPx = t.clientY - drag.startClientY;
      if (!drag.moved && Math.hypot(dxPx, dyPx) > DRAG_THRESHOLD) drag.moved = true;
      if (!drag.moved) return;
      ev.preventDefault();
      const { dx, dy } = screenDeltaToSvg(dxPx, dyPx);
      const newX = drag.startX + dx, newY = drag.startY + dy;
      animator.targets[drag.id] = { ...animator.targets[drag.id], x: newX, y: newY };
      animator.current[drag.id] = { ...animator.current[drag.id], x: newX, y: newY };
      animator.notify();
    };
    const onEnd = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const drag = dragNodeRef.current;
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      if (drag && drag.moved) {
        BASE_POSITIONS[drag.id] = { x: animator.current[drag.id].x, y: animator.current[drag.id].y };
      } else if (drag) {
        // Always call the LATEST selectNode via ref — fixes deselect-by-tap on mobile,
        // which was calling a stale first-render closure that could silently no-op.
        selectNodeRef.current && selectNodeRef.current(drag.id);
      }
      dragNodeRef.current = null;
    };
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd, { passive: false });
  }, [screenDeltaToSvg]);

  // ── Selection with staged animation ───────────────────────────────────────
  const selectNode = useCallback((id) => {
    if (id === selectedRef.current) { clearAll(); return; }

    // Cancel any pending stages from a previous selection sequence — otherwise
    // a quick re-click/deselect can let a stale setTimeout fire afterward and
    // silently re-apply old glow/size/position, making deselect look broken.
    selectionTimersRef.current.forEach(t => clearTimeout(t));
    selectionTimersRef.current = [];

    selectedRef.current = id;
    setSelected(id);
    setTab("overview");
    setOverviewFullscreen(false);
    setInsight(insightCache.current[id] || "");
    setBreadcrumb(prev => [...prev.filter(x=>x!==id).slice(-3), id]);
    // On mobile, start with panel collapsed so map stays visible
    if (window.innerWidth < 768) setPanelCollapsed(true);
    animator.stopBreathe(); // stop any previous breathe immediately

    // Line-glow wave disabled for now — felt distracting. Logic is kept intact
    // in EdgeWaveAnimator so it can be re-enabled later once refined.
    // edgeWave.select(id, NODES, EDGES);

    const cluster = new Set([id]);
    EDGES.forEach(([a,b]) => { if(a===id) cluster.add(b); if(b===id) cluster.add(a); });

    // Stage 1 (0ms): pulse the clicked node
    const pulse = {};
    NODES.forEach(n => { pulse[n.id] = { pulse: n.id===id ? 1 : 0 }; });
    animator.setTargets(pulse);

    // Stage 2 (80ms): fade unconnected, illuminate connected
    selectionTimersRef.current.push(setTimeout(() => {
      const fade = {};
      NODES.forEach(n => {
        fade[n.id] = {
          opacity: cluster.has(n.id) ? 1 : 0,
          glow:    n.id === id ? 1 : cluster.has(n.id) ? 0.5 : 0,
          pulse:   0,
        };
      });
      animator.setTargets(fade);
    }, 80));

    // Stage 3 (220ms): rescale to cluster-relative sizes + gather positions
    selectionTimersRef.current.push(setTimeout(() => {
      const clusterSizes = computeClusterSizes(id, NODES, EDGES, DEGREE_RANGES);
      const gatheredPos  = computeGatheredPositions(id, NODES, EDGES);
      const resize = {};
      NODES.forEach(n => {
        resize[n.id] = {
          radius: clusterSizes[n.id],
          x: gatheredPos[n.id].x,
          y: gatheredPos[n.id].y,
        };
      });
      animator.setTargets(resize);
    }, 220));

    // Stage 4 (300ms): recenter viewbox
    selectionTimersRef.current.push(setTimeout(() => recenterCluster(id), 300));

    // Stage 5 (600ms): hand glow over to the breathe loop once everything settles
    selectionTimersRef.current.push(setTimeout(() => animator.startBreathe(id), 600));

  }, [recenterCluster]);

  // Keep selectNodeRef pointed at the latest selectNode — touch/mouse handlers
  // below are memoized once (stable empty deps) and call through this ref so
  // they never invoke a stale closure.
  useEffect(() => { selectNodeRef.current = selectNode; }, [selectNode]);

  const clearAll = useCallback(() => {
    // Cancel any pending stages from the selection sequence — see note in selectNode
    selectionTimersRef.current.forEach(t => clearTimeout(t));
    selectionTimersRef.current = [];

    selectedRef.current = null;
    setSelected(null);
    setBreadcrumb([]);
    setOverviewFullscreen(false);
    setInsight("");
    setTooltip(null);
    setPanelCollapsed(false);
    animator.stopBreathe();
    // edgeWave.deselect(); // disabled along with the select() call above

    // Reset all nodes to base state including original positions
    const reset = {};
    NODES.forEach(n => {
      const p = basePos(n.id);
      reset[n.id] = { opacity:1, radius: NODE_SIZES[n.id] ?? 22, glow:0, pulse:0, x:p.x, y:p.y };
    });
    animator.setTargets(reset);

    // Reset viewbox after slight delay
    selectionTimersRef.current.push(setTimeout(() => resetViewBox(), 50));
  }, [resetViewBox]);

  const generateInsight = async () => {
    const n = nodeById(selected); if(!n) return;
    if(insightCache.current[selected]) { setInsight(insightCache.current[selected]); setTab("insight"); return; }
    setTab("insight"); setLoading(true); setInsight("");
    const rels = (n.links||[]).map(nodeById).filter(Boolean)
      .map(r=>`- ${r.full||r.label.replace("\n"," ")}: ${r.summary}`).join("\n");
    const prompt = `You are a warm, knowledgeable clinical educator. Someone is exploring a mental health knowledge map and landed on: "${n.full||n.label.replace("\n"," ")}".

Note content:
${n.content}

Connected concepts:
${rels||"None listed"}

Write 3–4 short paragraphs that:
1. Explain the clinical or lived essence in plain, accessible language
2. Describe when someone would benefit from this — from the perspective of a person experiencing it
3. Connect meaningfully to one or two related concepts
4. End with one practical "try this" micro-exercise

Tone: warm, grounded, specific. No headers, no bullets. Flowing prose only.`;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:1000,messages:[{role:"user",content:prompt}]})
      });
      const data = await res.json();
      const text = data.content?.map(b=>b.text||"").join("") || "No response.";
      insightCache.current[selected] = text;
      setInsight(text);
    } catch(e) { setInsight("Could not load insight. Please try again."); }
    setLoading(false);
  };

  const selectedNode = nodeById(selected);
  const connected    = selected ? connectedSet(selected) : null;
  const hasPractice  = selected && !!PRACTICES[selected];
  const hasHistory   = selected && !!HISTORY[selected];
  const hasLinks     = selected && !!LINKS[selected];
  const hasTips      = selected && !!TIPS[selected];

  const clusterLabels = [
    {x:50,  y:24, lines:["THERAPY","MODALITIES"], color:COLORS.modality.fill},
    {x:310, y:24, lines:["CORE","CONCEPTS"],       color:COLORS.concept.fill},
    {x:635, y:24, lines:["LIFE","CHALLENGES"],     color:COLORS.challenge.fill},
  ];

  return (
    <div style={{fontFamily:"'Inter','Helvetica Neue',sans-serif",background:"#070914",height:"100vh",maxHeight:"100dvh",width:"100vw",display:"flex",flexDirection:"column",color:"#e2e8f0",overflow:"hidden",position:"fixed",inset:0}}>
      <style>{`
        html, body { margin:0; padding:0; overflow:hidden; height:100%; }
      `}</style>
      <style>{`
        @keyframes spin { to { transform:rotate(360deg) } }
        svg text { pointer-events:none; user-select:none; }
        * { box-sizing: border-box; }
        .panel-scroll {
          flex: 1 1 0;
          overflow-y: auto !important;
          overflow-x: hidden;
          -webkit-overflow-scrolling: touch;
          overscroll-behavior: contain;
          touch-action: pan-y pinch-zoom;
          min-height: 0;
          padding: 16px;
        }
        .panel-scroll::-webkit-scrollbar { width: 4px; }
        .panel-scroll::-webkit-scrollbar-track { background: transparent; }
        .panel-scroll::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
        .panel-outer {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
          overflow: hidden;
        }
      `}</style>

      {/* Header */}
      <div style={{display:"flex",flexDirection:"column",background:"#0A0C1A",borderBottom:"1px solid #1C2040",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",padding:"10px 20px 4px"}}>
          <span style={{fontWeight:600,fontSize:14,color:"#f1f5f9",letterSpacing:"-0.01em"}}>Mental Map</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:18,padding:"2px 20px 12px",flexWrap:"wrap"}}>
          {LEGEND.map(l=>(
            <span key={l.type} style={{display:"flex",alignItems:"center",fontSize:13.5,fontWeight:600,color:"#cbd5e1"}}>
              <span style={{width:13,height:13,borderRadius:"50%",background:COLORS[l.type].fill,display:"inline-block",marginRight:7,boxShadow:`0 0 8px ${COLORS[l.type].fill}99`}}/>
              {l.label}
            </span>
          ))}
        </div>
      </div>

      {/* Body */}
      <div style={{flex:1,display:"flex",overflow:"hidden",minHeight:0}}>

        {/* Canvas */}
        <div style={{flex:1,position:"relative",overflow:"hidden",minWidth:0}}>
          <svg ref={svgRef}
            viewBox={viewBox}
            style={{width:"100%",height:"100%",display:"block",touchAction:"none"}}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          >
            <defs>
              {/* Starry Night background gradient */}
              <radialGradient id="starryBg" cx="50%" cy="35%" r="75%">
                <stop offset="0%" stopColor="#0D1024"/>
                <stop offset="100%" stopColor="#03040A"/>
              </radialGradient>

              {/* Ambient + selected glow halos — radial gradients only, no blur filters.
                  feGaussianBlur filters were the main cost during the click-selection
                  sequence: the browser must re-rasterize every blurred element on every
                  animation frame. Gradients are pre-computed once and composited cheaply,
                  even with many of them animating opacity/size simultaneously. */}
              {Object.entries(COLORS).map(([type, c]) => (
                <radialGradient key={`halo-${type}`} id={`star-halo-${type}`} cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor={c.fill} stopOpacity="0.55"/>
                  <stop offset="60%" stopColor={c.fill} stopOpacity="0.18"/>
                  <stop offset="100%" stopColor={c.fill} stopOpacity="0"/>
                </radialGradient>
              ))}
            </defs>

            <rect width={CANVAS_BOUNDS.width} height={CANVAS_BOUNDS.height} x={CANVAS_BOUNDS.x} y={CANVAS_BOUNDS.y} fill="url(#starryBg)"
              onMouseDown={onCanvasMouseDown}
              onClick={() => { if (!canvasJustPannedRef.current && !canvasJustPannedTouchRef.current) selected && clearAll(); }}
              style={{cursor: selected ? "pointer" : "grab"}}
            />

            {/* Scattered background star field — twinkles via CSS animation (cheap,
                GPU-composited opacity changes) rather than per-element SMIL <animate>
                tags, which were costly with 140 elements running simultaneously.
                A handful of shared keyframe variants + staggered delay/duration
                keeps it visually varied without the per-frame cost. */}
            <style>{`
              @keyframes starTwinkleA { 0%,100% { opacity:0.2; } 50% { opacity:0.9; } }
              @keyframes starTwinkleB { 0%,100% { opacity:0.15; } 50% { opacity:0.75; } }
              @keyframes starTwinkleC { 0%,100% { opacity:0.25; } 50% { opacity:1; } }
              .bg-star { animation-iteration-count: infinite; animation-timing-function: ease-in-out; }
            `}</style>
            <g style={{opacity: selected ? 0 : 1, transition: "opacity 0.6s ease", pointerEvents: "none"}}>
              {BACKGROUND_STARS.map((s,i)=>(
                <circle key={`bgstar-${i}`} cx={s.x} cy={s.y} r={s.r} fill="#fff"
                  className="bg-star"
                  style={{
                    animationName: `starTwinkle${["A","B","C"][i % 3]}`,
                    animationDuration: `${2.2 + s.r * 0.8}s`,
                    animationDelay: `${s.delay}s`,
                  }}
                />
              ))}
            </g>
            {/* Cluster title labels removed from the canvas — "THERAPY / MODALITIES"
                in particular was getting clipped at small/mobile viewport widths
                since it sits at the top-left edge. The header legend already
                labels every node type with a colored dot, so it's the single
                source of truth for cluster identity now. */}

            {/* Edges — base purple line + traveling "headlight" overlay from selected node */}
            {EDGES.map(([a,b],i)=>{
              const na=nodeById(a), nb=nodeById(b); if(!na||!nb) return null;
              const hi = connected && connected.has(a) && connected.has(b);
              const aAnim = animState?.[a], bAnim = animState?.[b];
              const ax = aAnim?.x ?? basePos(a).x, ay = aAnim?.y ?? basePos(a).y;
              const bx = bAnim?.x ?? basePos(b).x, by = bAnim?.y ?? basePos(b).y;
              const aOp = aAnim?.opacity ?? 1;
              const bOp = bAnim?.opacity ?? 1;
              const edgeOp = Math.min(aOp, bOp) * (hi ? 0.7 : !connected ? 0.32 : 0.05);

              const touchesSelected = selected && (a === selected || b === selected);
              const glowVal = touchesSelected ? edgeWave.get(a, b) : 0;
              const isAmbient = edgeWave.mode === "ambient";

              // Headlight travels FROM the selected node TOWARD the neighbor.
              const srcX = a === selected ? ax : bx, srcY = a === selected ? ay : by;
              const dstX = a === selected ? bx : ax, dstY = a === selected ? by : ay;
              const lineLen = Math.hypot(dstX - srcX, dstY - srcY);

              // The "car" position along the line (0 = at selected node, 1 = arrived)
              const headPos = Math.min(1, glowVal);
              const headX = srcX + (dstX - srcX) * headPos;
              const headY = srcY + (dstY - srcY) * headPos;
              // Trail behind the headlight, fixed pixel length so it reads as a
              // short beam rather than a fill — shorter trail on shorter lines.
              const trailLenPx = Math.min(lineLen * 0.4, 55);
              const trailT = Math.max(0, headPos - trailLenPx / Math.max(lineLen, 1));
              const trailX = srcX + (dstX - srcX) * trailT;
              const trailY = srcY + (dstY - srcY) * trailT;

              const PURPLE = "#7F77DD";
              const PURPLE_BRIGHT = "#B8B3F0"; // lightened purple — the headlight itself

              return (
                <g key={i}>
                  <line
                    x1={ax} y1={ay} x2={bx} y2={by}
                    stroke={hi ? PURPLE : "#445a82"}
                    strokeWidth={hi ? 2 : 1}
                    strokeOpacity={edgeOp}
                  />
                  {touchesSelected && !isAmbient && glowVal > 0.005 && glowVal < 1 && (
                    <line
                      x1={trailX} y1={trailY}
                      x2={headX} y2={headY}
                      stroke={PURPLE_BRIGHT}
                      strokeWidth={3}
                      strokeOpacity={0.95}
                      strokeLinecap="round"
                    />
                  )}
                  {touchesSelected && isAmbient && (
                    <line
                      x1={srcX} y1={srcY} x2={dstX} y2={dstY}
                      stroke={PURPLE_BRIGHT}
                      strokeWidth={2}
                      strokeOpacity={(edgeWave.ambient[edgeWave.key(a,b)] ?? edgeWave.ambient[edgeWave.key(b,a)] ?? 0) * 0.55}
                      strokeLinecap="round"
                    />
                  )}
                </g>
              );
            })}

            {/* Nodes */}
            {NODES.map(n=>{
              const c = COLORS[n.type];
              const anim = animState?.[n.id];
              const r    = anim?.radius ?? NODE_SIZES[n.id] ?? 22;
              const op   = anim?.opacity ?? 1;
              const glow = anim?.glow ?? 0;
              const pulse = anim?.pulse ?? 0;
              const nx   = anim?.x ?? basePos(n.id).x;
              const ny   = anim?.y ?? basePos(n.id).y;
              const isSel = selected === n.id;
              const lines = n.label.split("\n");
              const fs    = Math.max(8, Math.min(13, 7 + r * 0.19));
              const lh    = fs + 3;
              const startY = -(lines.length-1)*lh/2;
              const hasPr = !!PRACTICES[n.id];

              return (
                <g key={n.id}
                  transform={`translate(${nx},${ny})`}
                  opacity={op}
                  style={{cursor: op < 0.05 ? "default" : "grab"}}
                  onMouseDown={e => op > 0.05 && onNodeMouseDown(e, n.id)}
                  onTouchStart={e => op > 0.05 && onNodeTouchStart(e, n.id)}
                  onMouseEnter={e => {
                    if (op < 0.1) return;
                    const svg = e.currentTarget.closest("svg");
                    const rect = svg.getBoundingClientRect();
                    const wrap = svg.parentElement.getBoundingClientRect();
                    const vb = viewBox.split(" ").map(Number);
                    const scaleX = rect.width / vb[2];
                    const scaleY = rect.height / vb[3];
                    const nodePx = rect.left - wrap.left + (nx - vb[0]) * scaleX;
                    const nodePy = rect.top  - wrap.top  + (ny - vb[1]) * scaleY;
                    const nodeRadiusPx = r * scaleY;

                    const TOOLTIP_W = 220, TOOLTIP_PAD = 12;
                    const wrapW = wrap.width, wrapH = wrap.height;

                    // Clamp horizontal so the box never spills past the canvas edges,
                    // even though it visually still "points" at the node via the arrow.
                    const halfW = TOOLTIP_W / 2;
                    const clampedX = Math.min(Math.max(nodePx, halfW + TOOLTIP_PAD), wrapW - halfW - TOOLTIP_PAD);

                    // Flip below the node if there isn't enough room above it
                    const estTooltipH = 90; // rough height incl. padding, enough for 2-3 lines
                    const spaceAbove = nodePy - nodeRadiusPx - 12;
                    const placeBelow = spaceAbove < estTooltipH;
                    const py = placeBelow
                      ? nodePy + nodeRadiusPx + 12
                      : nodePy - nodeRadiusPx - 12;

                    setTooltip({
                      x: clampedX, y: py, flip: placeBelow,
                      arrowOffset: Math.max(-halfW + 14, Math.min(halfW - 14, nodePx - clampedX)),
                      name: n.full||n.label.replace("\n"," "), text: n.summary||"", color: c.fill
                    });
                  }}
                  onMouseLeave={() => setTooltip(null)}
                >
                  {/* Always-on soft glow halo — gives every star its characteristic
                      luminous fuzz, matching the Starry Night reference look */}
                  <circle r={r*2.4} fill={`url(#star-halo-${n.type})`} opacity={0.55 + glow*0.35}/>

                  {/* Selected node: brighter halo via the same cheap gradient, just larger */}
                  {isSel && (
                    <>
                      <circle r={r+16} fill="none" stroke="#fff" strokeWidth="1" strokeOpacity={0.12 + glow*0.18}/>
                      <circle r={r*3.1} fill={`url(#star-halo-${n.type})`} opacity={0.5 + glow*0.3}/>
                    </>
                  )}

                  {/* Second ring for high-glow connected nodes */}
                  {!isSel && glow > 0.3 && (
                    <circle r={r+5} fill="none"
                      stroke={c.fill} strokeWidth="1" strokeOpacity={glow*0.25}/>
                  )}

                  <circle r={r}
                    fill={c.fill}
                    stroke={c.stroke}
                    strokeWidth={isSel ? 2.5 : 1.5}
                  />

                  {/* Bright whitish core — present on every node (not just selected) to
                      match the Starry Night reference: every star has a lit center */}
                  <circle r={r*0.4} fill="#fff" opacity={isSel ? 0.85 : 0.55}/>

                  {hasPr && !isSel && (
                    <circle r={4} cx={r-3} cy={-(r-3)}
                      fill="#378ADD" stroke="#070914" strokeWidth="1.5"/>
                  )}
                  {/* Label sits BELOW the node, colored to match its type — matches reference */}
                  {lines.map((ln,i)=>(
                    <text key={i} textAnchor="middle" y={r + 16 + i*lh}
                      fontSize={fs} fontWeight={isSel?700:500} fill={c.fill}
                      fontFamily="Inter,sans-serif">
                      {ln}
                    </text>
                  ))}
                </g>
              );
            })}
          </svg>

          {/* Custom tooltip — clamped to viewport, flips below node near top edge */}
          {tooltip && (
            <div style={{
              position:"absolute", left:tooltip.x, top:tooltip.y,
              transform: tooltip.flip ? "translate(-50%, 0)" : "translate(-50%, -100%)",
              pointerEvents:"none", zIndex:50,
              maxWidth:220, background:"#0A0C1A",
              border:`1px solid ${tooltip.color}55`, borderRadius:10,
              padding:"9px 12px", boxShadow:"0 4px 20px rgba(0,0,0,0.5)",
            }}>
              <p style={{fontSize:11,fontWeight:600,color:tooltip.color,margin:"0 0 4px",letterSpacing:".04em",textTransform:"uppercase",lineHeight:1.3}}>{tooltip.name}</p>
              <p style={{fontSize:12.5,color:"#cbd5e1",margin:0,lineHeight:1.6}}>{tooltip.text}</p>
              {/* Arrow shifts to stay aligned under/above the actual node, even when the box itself is clamped */}
              <div style={{
                position:"absolute",
                [tooltip.flip ? "top" : "bottom"]: -6,
                left: `calc(50% + ${tooltip.arrowOffset || 0}px)`,
                transform:"translateX(-50%)", width:10, height:6, overflow:"hidden"
              }}>
                <div style={{
                  width:10, height:10, background:"#0A0C1A",
                  border:`1px solid ${tooltip.color}55`,
                  transform: tooltip.flip ? "rotate(45deg)" : "rotate(45deg)",
                  transformOrigin: tooltip.flip ? "bottom right" : "top left",
                  marginTop: tooltip.flip ? -7 : 3,
                }}/>
              </div>
            </div>
          )}

          {/* Breadcrumb */}
          {breadcrumb.length > 0 && (
            <div style={{position:"absolute",top:10,left:10,zIndex:10,display:"flex",alignItems:"center",gap:4,background:"rgba(13,19,37,0.9)",backdropFilter:"blur(6px)",border:"1px solid #1C2040",borderRadius:8,padding:"5px 10px",flexWrap:"wrap"}}>
              <button style={{background:"none",border:"none",color:"#64748b",cursor:"pointer",fontSize:12,fontFamily:"inherit"}} onClick={clearAll}>All</button>
              {breadcrumb.map((id,i)=>{
                const n=nodeById(id);
                return (
                  <span key={id} style={{display:"flex",alignItems:"center",gap:4}}>
                    <span style={{color:"#334155",fontSize:11}}>›</span>
                    <button style={{background:"none",border:"none",color:i===breadcrumb.length-1?"#e2e8f0":"#64748b",cursor:"pointer",fontSize:12,fontFamily:"inherit",fontWeight:i===breadcrumb.length-1?600:400}} onClick={()=>selectNode(id)}>
                      {(n?.label||id).replace("\n"," ")}
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          {!selected && (
            <div style={{position:"absolute",bottom:12,left:"50%",transform:"translateX(-50%)",background:"rgba(13,19,37,0.85)",backdropFilter:"blur(6px)",border:"1px solid #1C2040",borderRadius:20,padding:"6px 16px",fontSize:12,color:"#64748b",pointerEvents:"none",whiteSpace:"nowrap"}}>
              Click any node to explore · <span style={{color:"#378ADD"}}>●</span> = has guided practice
            </div>
          )}

          <SuggestWidget mode="floating" nodeLabel={selectedNode ? selectedNode.label : null} />
        </div>

        {/* Drag divider — tap to toggle, drag to resize */}
        {selectedNode && !panelCollapsed && (
          <div
            onMouseDown={onDividerMouseDown}
            onTouchStart={onDividerTouchStart}
            style={{
              width: 24, flexShrink: 0, cursor: "col-resize", zIndex: 25,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "#0A0C1A", borderLeft: "1px solid #1C2040",
              userSelect: "none",
            }}
          >
            <div style={{display:"flex",flexDirection:"column",gap:3}}>
              {[0,1,2,3].map(i=>(
                <div key={i} style={{width:3,height:3,borderRadius:"50%",background:"#475569"}}/>
              ))}
            </div>
          </div>
        )}

        {/* Peek tab — tap or drag to reopen */}
        {selectedNode && panelCollapsed && (
          <div
            onMouseDown={onDividerMouseDown}
            onTouchStart={onDividerTouchStart}
            style={{
              width: 28, flexShrink: 0, cursor: "pointer", zIndex: 25,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "#0A0C1A", borderLeft: "1px solid #1C2040",
              userSelect: "none",
            }}
          >
            <span style={{fontSize:16, color:"#7F77DD"}}>‹</span>
          </div>
        )}

        {/* Detail Panel — zero width when no node or collapsed */}
        {selectedNode && (
          <div style={{
            width: panelCollapsed ? 0 : panelWidth,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            background: "#0A0C1A",
            overflow: "hidden",
            transition: "width .3s ease",
            zIndex: 20,
            minHeight: 0,
          }}>
            <div style={{
              width: panelWidth,
              display: "flex",
              flexDirection: "column",
              height: "100%",
              minHeight: 0,
            }}>
              <div style={{padding:"16px 16px 0",position:"relative",flexShrink:0,background:"#0A0C1A",zIndex:2}}>
                <button style={{position:"absolute",top:14,right:14,background:"none",border:"none",color:"#475569",cursor:"pointer",fontSize:18,lineHeight:1,fontFamily:"inherit"}} onClick={clearAll}>✕</button>
                <div style={{fontSize:10.5,fontWeight:600,letterSpacing:".08em",textTransform:"uppercase",color:COLORS[selectedNode.type]?.fill,marginBottom:3}}>{COLORS[selectedNode.type]?.typeLabel}</div>
                <div style={{fontSize:17,fontWeight:600,color:"#f1f5f9",lineHeight:1.25,marginBottom:12,paddingRight:24,letterSpacing:"-0.02em"}}>{selectedNode.full||selectedNode.label.replace("\n"," ")}</div>
                {/* Tabs */}
                <div style={{display:"flex",borderBottom:"1px solid #1C2040",overflowX:"auto"}}>
                  {["overview", ...(hasHistory?["history"]:[]), ...(hasLinks?["links"]:[]), ...(hasPractice?["practice"]:[]), ...(hasTips?["tips"]:[]), "insight"].map(t=>(
                    <button key={t} style={{flexShrink:0,padding:"8px 10px",background:"none",border:"none",borderBottom:`2px solid ${tab===t?"#7F77DD":"transparent"}`,color:tab===t?"#e2e8f0":"#64748b",cursor:"pointer",fontSize:12,fontWeight:tab===t?600:400,fontFamily:"inherit",whiteSpace:"nowrap"}}
                      onClick={()=>setTab(t)}>
                      {t==="overview"?"Overview":t==="history"?"⏱ History":t==="links"?"🔗 Links":t==="tips"?"💡 Tips":t==="practice"?"▶ Practice":"✦ AI insight"}
                    </button>
                  ))}
                </div>
                <div style={{padding:"6px 0 4px"}}>
                  <SuggestWidget mode="inline" nodeLabel={selectedNode.full || selectedNode.label.replace("\n"," ")} />
                </div>
              </div>

              {/* Panel body — manual touch scroll for mobile Safari compatibility */}
              <div
                ref={panelBodyRef}
                onWheel={onPanelWheel}
                style={{
                  flex: 1,
                  overflow: "hidden",
                  position: "relative",
                  minHeight: 0,
                }}
              >
                <div
                  ref={panelContentRef}
                  style={{
                    position: "absolute",
                    top: 0, left: 0, right: 0,
                    transform: `translateY(${panelScrollY}px)`,
                    padding: 16,
                    boxSizing: "border-box",
                    willChange: "transform",
                  }}
                  onTouchStart={onPanelTouchStart}
                  onTouchMove={onPanelTouchMove}
                  onTouchEnd={onPanelTouchEnd}
                >
                {tab==="overview" && (
                  <div>
                    <p style={{fontSize:13.5,lineHeight:1.7,color:"#94a3b8",marginBottom:14}}>{selectedNode.summary}</p>
                    <div style={{fontSize:13,lineHeight:1.75,color:"#cbd5e1",whiteSpace:"pre-line",background:"#060812",borderRadius:8,padding:"12px 14px",marginBottom:14,border:"1px solid #1C2040"}}>{selectedNode.content}</div>

                    {/* IFS character feed — Instagram-style swipeable cards */}
                    {selected === "ifs" && (
                      <div style={{marginBottom:14}}>
                        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                          <p style={{fontSize:10.5,fontWeight:600,letterSpacing:".07em",textTransform:"uppercase",color:"#475569",margin:0}}>Meet the parts</p>
                          <button onClick={()=>setOverviewFullscreen(true)} style={{
                            display:"flex",alignItems:"center",gap:4,background:"none",border:"1px solid #1C2040",
                            borderRadius:7,padding:"4px 9px",color:"#94a3b8",fontSize:11,cursor:"pointer",fontFamily:"inherit"
                          }}>
                            ⤢ Fullscreen
                          </button>
                        </div>
                        <IFSFeed fullscreen={false}/>
                      </div>
                    )}

                    {/* Somatic practice feed — Instagram-style swipeable cards */}
                    {selected === "somatic" && (
                      <div style={{marginBottom:14}}>
                        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                          <p style={{fontSize:10.5,fontWeight:600,letterSpacing:".07em",textTransform:"uppercase",color:"#475569",margin:0}}>Key practices</p>
                          <button onClick={()=>setOverviewFullscreen(true)} style={{
                            display:"flex",alignItems:"center",gap:4,background:"none",border:"1px solid #1C2040",
                            borderRadius:7,padding:"4px 9px",color:"#94a3b8",fontSize:11,cursor:"pointer",fontFamily:"inherit"
                          }}>
                            ⤢ Fullscreen
                          </button>
                        </div>
                        <SomaticFeed fullscreen={false}/>
                      </div>
                    )}

                    {(selectedNode.links||[]).length > 0 && (
                      <div style={{marginBottom:14}}>
                        <p style={{fontSize:10.5,fontWeight:600,letterSpacing:".07em",textTransform:"uppercase",color:"#475569",marginBottom:8}}>Related</p>
                        {(selectedNode.links||[]).map(lid=>{
                          const ln=nodeById(lid); if(!ln) return null;
                          const c=COLORS[ln.type];
                          return (
                            <button key={lid} style={{display:"inline-block",fontSize:12,padding:"3px 10px",borderRadius:20,cursor:"pointer",margin:"2px 3px 2px 0",background:c.chip,border:`1px solid ${c.chipBorder}`,color:c.chipText,fontFamily:"inherit"}} onClick={()=>selectNode(lid)}>
                              {ln.label.replace("\n"," ")}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <button style={{width:"100%",padding:"11px",background:"linear-gradient(135deg,#534AB7,#7F77DD)",border:"none",borderRadius:8,color:"#fff",fontSize:13.5,cursor:"pointer",fontFamily:"inherit",fontWeight:600,marginTop:4}} onClick={generateInsight}>
                      ✦ Generate clinical insight
                    </button>
                  </div>
                )}
                {tab==="practice" && <PracticePanel nodeId={selected}/>}
                {tab==="history"  && <HistoryPanel  nodeId={selected}/>}
                {tab==="links"    && <LinksPanel    nodeId={selected}/>}
                {tab==="tips"     && <TipsPanel     nodeId={selected}/>}
                {tab==="insight"  && (
                  <div>
                    {loading
                      ? <div style={{width:28,height:28,border:"2px solid #1C2040",borderTop:"2px solid #7F77DD",borderRadius:"50%",animation:"spin .7s linear infinite",margin:"48px auto"}}/>
                      : insight
                        ? <>
                            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,paddingBottom:12,borderBottom:"1px solid #1C2040"}}>
                              <span style={{fontSize:12,color:"#7F77DD",fontWeight:600}}>✦</span>
                              <span style={{fontSize:11,color:"#475569",letterSpacing:".06em",textTransform:"uppercase",fontWeight:600}}>Claude · Clinical insight</span>
                            </div>
                            <p style={{fontSize:13.5,lineHeight:1.8,color:"#cbd5e1",whiteSpace:"pre-wrap",margin:0}}>{insight}</p>
                            <button onClick={()=>{insightCache.current[selected]="";generateInsight();}}
                              style={{marginTop:16,padding:"7px 14px",background:"transparent",border:"1px solid #1C2040",borderRadius:7,color:"#64748b",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>
                              Regenerate ↻
                            </button>
                          </>
                        : <div style={{textAlign:"center",paddingTop:48}}>
                            <p style={{color:"#475569",fontSize:13,marginBottom:16}}>No insight generated yet.</p>
                            <button style={{padding:"9px 20px",background:"linear-gradient(135deg,#534AB7,#7F77DD)",border:"none",borderRadius:8,color:"#fff",fontSize:13,cursor:"pointer",fontFamily:"inherit"}} onClick={generateInsight}>Generate insight</button>
                          </div>
                    }
                  </div>
                )}
                {/* Bottom padding so last content isn't flush against edge */}
                <div style={{height:32}}/>
                </div>{/* end content */}

                {/* Scrollbar track indicator */}
                {panelScrollThumb > 0 && panelScrollThumb < 1 && (
                  <div style={{position:"absolute",right:3,top:0,bottom:0,width:3,pointerEvents:"none"}}>
                    <div style={{
                      position:"absolute",
                      right:0,
                      width:3,
                      borderRadius:3,
                      background:"#334155",
                      top: `${(-panelScrollY / panelMaxScroll) * (100 - panelScrollThumb*100)}%`,
                      height: `${panelScrollThumb * 100}%`,
                      opacity: panelScrolling ? 1 : 0,
                      transition: "opacity 0.5s ease",
                    }}/>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Overview fullscreen overlay — map/tabs stay mounted underneath,
          this just sits on top so a back button returns instantly */}
      {overviewFullscreen && selectedNode && (
        <div style={{
          position:"fixed", top:0, left:0, right:0, bottom:0, zIndex:100,
          background:"#070914", display:"flex", flexDirection:"column",
          overflowY:"auto", WebkitOverflowScrolling:"touch",
        }}>
          <div style={{
            display:"flex", alignItems:"center", gap:10, padding:"14px 16px",
            borderBottom:"1px solid #1C2040", flexShrink:0, position:"sticky", top:0,
            background:"#070914", zIndex:2,
          }}>
            <button onClick={()=>setOverviewFullscreen(false)} style={{
              display:"flex", alignItems:"center", gap:6, background:"none",
              border:"1px solid #1C2040", borderRadius:8, padding:"6px 12px",
              color:"#94a3b8", fontSize:13, cursor:"pointer", fontFamily:"inherit"
            }}>‹ Back to map</button>
            <span style={{fontSize:13, fontWeight:600, color:"#f1f5f9"}}>
              {selectedNode.full || selectedNode.label.replace("\n"," ")}
            </span>
          </div>
          <div style={{flex:1, padding:"24px 16px 60px"}}>
            {selected === "ifs" && <IFSFeed fullscreen={true}/>}
            {selected === "somatic" && <SomaticFeed fullscreen={true}/>}
          </div>
        </div>
      )}
    </div>
  );
}
