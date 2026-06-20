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
  modality:  { fill:"#1D9E75", stroke:"#085041", text:"#fff", chip:"#E1F5EE", chipBorder:"#5DCAA5", chipText:"#085041", typeLabel:"Therapy modality" },
  concept:   { fill:"#7F77DD", stroke:"#3C3489", text:"#fff", chip:"#EEEDFE", chipBorder:"#AFA9EC", chipText:"#3C3489", typeLabel:"Core concept" },
  challenge: { fill:"#D85A30", stroke:"#712B13", text:"#fff", chip:"#FAECE7", chipBorder:"#F0997B", chipText:"#712B13", typeLabel:"Life challenge" },
  skill:     { fill:"#378ADD", stroke:"#0C447C", text:"#fff", chip:"#E6F1FB", chipBorder:"#85B7EB", chipText:"#042C53", typeLabel:"Skill / technique" },
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
   content:"Developed by Peter Levine, SE focuses on body sensation rather than narrative. Clients learn to track and discharge incomplete survival responses.\n\nKey concepts: titration (small doses), pendulation (moving between ease and activation).",
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
          background:"#080c18", border:"1px solid #1a2540", borderRadius:8,
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
          background: "#080c18",
          border: "1px solid #1a2540",
          borderRadius: 8,
          padding: "12px 14px",
          marginBottom: 10,
          transition: "border-color 0.15s ease",
        }}
        onMouseEnter={e => e.currentTarget.style.borderColor = lvl.border}
        onMouseLeave={e => e.currentTarget.style.borderColor = "#1a2540"}
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
        background:"#0d1325", border:"1px solid #1a2540", borderRadius:8,
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

      <div style={{marginTop:6, padding:"10px 12px", background:"#080c18", borderRadius:8, border:"1px solid #1a2540"}}>
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
          <div key={d.label} style={{flex:1,minWidth:100,background:"#080c18",border:"1px solid #1a2540",borderRadius:8,padding:"8px 12px"}}>
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
              {i < h.milestones.length-1 && <div style={{width:1,flex:1,background:"#1a2540",marginTop:4}}/>}
            </div>
            <div style={{paddingBottom:i < h.milestones.length-1 ? 6 : 0}}>
              <span style={{fontSize:11,fontWeight:700,color:"#1D9E75",display:"block",marginBottom:3}}>{m.year}</span>
              <p style={{fontSize:13,lineHeight:1.65,color:"#cbd5e1",margin:0}}>{m.event}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Context box */}
      <div style={{background:"#080c18",border:"1px solid #1a2540",borderRadius:8,padding:"12px 14px"}}>
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
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,paddingBottom:14,borderBottom:"1px solid #1a2540"}}>
        <div>
          <p style={{fontSize:10.5,fontWeight:600,letterSpacing:".07em",textTransform:"uppercase",color:"#378ADD",margin:"0 0 2px"}}>Guided practice</p>
          <p style={{fontSize:15,fontWeight:600,color:"#f1f5f9",margin:0,letterSpacing:"-0.01em"}}>{practice.title}</p>
        </div>
        <span style={{marginLeft:"auto",fontSize:11.5,color:"#475569",background:"#0a0f1e",border:"1px solid #1a2540",borderRadius:20,padding:"3px 10px",whiteSpace:"nowrap",flexShrink:0}}>{practice.duration}</span>
      </div>

      <p style={{fontSize:13.5,lineHeight:1.75,color:"#94a3b8",marginBottom:20,whiteSpace:"pre-line"}}>{practice.intro}</p>

      {practice.steps.map((step, i) => (
        <div key={i} style={{marginBottom:20,paddingLeft:14,borderLeft:"2px solid #1a2540",position:"relative"}}>
          <div style={{position:"absolute",left:-7,top:2,width:12,height:12,borderRadius:"50%",background:"#378ADD",border:"2px solid #0a0f1e",flexShrink:0}}/>
          <p style={{fontSize:12,fontWeight:600,color:"#378ADD",margin:"0 0 6px",letterSpacing:".02em"}}>{step.heading}</p>
          <p style={{fontSize:13.5,lineHeight:1.78,color:"#cbd5e1",margin:0,whiteSpace:"pre-line"}}>{step.body}</p>
        </div>
      ))}

      <div style={{marginTop:8,padding:"12px 14px",background:"#080c18",borderRadius:8,border:"1px solid #1a2540"}}>
        <p style={{fontSize:12,color:"#475569",margin:0,lineHeight:1.6}}>
          <span style={{color:"#378ADD",fontWeight:600}}>Tip: </span>
          You can return to this practice as many times as you like. Each time will feel different — and that's exactly right.
        </p>
      </div>
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
  const { iterations = 12, gap = 14, getRadius = (n) => RADIUS_LOOKUP[n.id] ?? 24 } = opts;

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
  resolveCollisions(positions, NODES, null, { gap: 10 });
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
    const onUp = () => {
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
    const onEnd = () => {
      // If barely moved = tap → toggle collapse
      if (!dragRef.current.moved) {
        setPanelCollapsed(prev => !prev);
      }
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
    };
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
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
  const onTouchStart = useCallback((e) => {
    if (e.touches.length === 2) {
      isPinching.current = true;
      const t = e.touches;
      lastPinchDist.current = Math.hypot(t[0].clientX-t[1].clientX, t[0].clientY-t[1].clientY);
      lastPinchMid.current = { x:(t[0].clientX+t[1].clientX)/2, y:(t[0].clientY+t[1].clientY)/2 };
    } else {
      isPinching.current = false;
    }
  }, []);

  const onTouchMove = useCallback((e) => {
    if (!isPinching.current || e.touches.length !== 2) return;
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
  }, [applyViewBox]);

  const onTouchEnd = useCallback(() => { isPinching.current = false; }, []);

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

  // Convert a screen-pixel delta into SVG-coordinate delta, accounting for
  // the current zoom level (viewBox width/height vs actual rendered size).
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
        // Treated as a normal click, not a drag
        selectNode(drag.id);
      }
      dragNodeRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [screenDeltaToSvg]);

  const onNodeTouchStart = useCallback((e, id) => {
    if (e.touches.length !== 1) return; // let pinch-zoom own multi-touch
    e.stopPropagation();
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
    const onEnd = () => {
      const drag = dragNodeRef.current;
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      if (drag && drag.moved) {
        BASE_POSITIONS[drag.id] = { x: animator.current[drag.id].x, y: animator.current[drag.id].y };
      } else if (drag) {
        selectNode(drag.id);
      }
      dragNodeRef.current = null;
    };
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
  }, [screenDeltaToSvg]);

  // ── Selection with staged animation ───────────────────────────────────────
  const selectNode = useCallback((id) => {
    if (id === selectedRef.current) { clearAll(); return; }
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
    setTimeout(() => {
      const fade = {};
      NODES.forEach(n => {
        fade[n.id] = {
          opacity: cluster.has(n.id) ? 1 : 0,
          glow:    n.id === id ? 1 : cluster.has(n.id) ? 0.5 : 0,
          pulse:   0,
        };
      });
      animator.setTargets(fade);
    }, 80);

    // Stage 3 (220ms): rescale to cluster-relative sizes + gather positions
    setTimeout(() => {
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
    }, 220);

    // Stage 4 (300ms): recenter viewbox
    setTimeout(() => recenterCluster(id), 300);

    // Stage 5 (600ms): hand glow over to the breathe loop once everything settles
    setTimeout(() => animator.startBreathe(id), 600);

  }, [recenterCluster]);

  const clearAll = useCallback(() => {
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
    setTimeout(() => resetViewBox(), 50);
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
    {x:50,  y:22, text:"Therapy modalities", color:COLORS.modality.fill},
    {x:310, y:22, text:"Core concepts",       color:COLORS.concept.fill},
    {x:635, y:22, text:"Life challenges",     color:COLORS.challenge.fill},
  ];

  return (
    <div style={{fontFamily:"'Inter','Helvetica Neue',sans-serif",background:"#0a0f1e",height:"100vh",width:"100vw",display:"flex",flexDirection:"column",color:"#e2e8f0",overflow:"hidden",position:"fixed",top:0,left:0}}>
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
      <div style={{display:"flex",alignItems:"center",gap:16,padding:"10px 20px",background:"#0d1325",borderBottom:"1px solid #1a2540",flexShrink:0,flexWrap:"wrap"}}>
        <span style={{fontWeight:600,fontSize:14,color:"#f1f5f9",letterSpacing:"-0.01em"}}>Mental Map</span>
        {LEGEND.map(l=>(
          <span key={l.type} style={{display:"flex",alignItems:"center",fontSize:11.5,color:"#64748b"}}>
            <span style={{width:9,height:9,borderRadius:"50%",background:COLORS[l.type].fill,display:"inline-block",marginRight:5}}/>
            {l.label}
          </span>
        ))}
      </div>

      {/* Body */}
      <div style={{flex:1,display:"flex",overflow:"hidden",minHeight:0}}>

        {/* Canvas */}
        <div style={{flex:1,position:"relative",overflow:"hidden",minWidth:0}}>
          <svg ref={svgRef}
            viewBox={viewBox}
            style={{width:"100%",height:"100%",display:"block"}}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          >
            <defs>
              {/* Glow filters per type */}
              {Object.entries(COLORS).map(([type, c]) => (
                <filter key={type} id={`glow-${type}`} x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation="6" result="blur"/>
                  <feFlood floodColor={c.fill} floodOpacity="0.7" result="color"/>
                  <feComposite in="color" in2="blur" operator="in" result="glow"/>
                  <feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>
                </filter>
              ))}
              {/* Pulse filter */}
              <filter id="pulse-filter" x="-80%" y="-80%" width="260%" height="260%">
                <feGaussianBlur stdDeviation="10" result="blur"/>
                <feFlood floodColor="#ffffff" floodOpacity="0.25" result="color"/>
                <feComposite in="color" in2="blur" operator="in" result="glow"/>
                <feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>
              </filter>
            </defs>

            <rect width="1800" height="1260" x="-450" y="-315" fill="#0a0f1e"
              onClick={() => selected && clearAll()}
              style={{cursor: selected ? "pointer" : "default"}}
            />

            {/* Cluster labels */}
            {clusterLabels.map(l=>(
              <text key={l.text} x={l.x} y={l.y} fontSize="10.5" fontWeight="500"
                fill={l.color} opacity={selected ? 0 : 0.65}
                fontFamily="Inter,sans-serif"
                style={{transition:"opacity 0.4s ease"}}>
                {l.text}
              </text>
            ))}

            {/* Edges — base purple line + traveling "headlight" overlay from selected node */}
            {EDGES.map(([a,b],i)=>{
              const na=nodeById(a), nb=nodeById(b); if(!na||!nb) return null;
              const hi = connected && connected.has(a) && connected.has(b);
              const aAnim = animState?.[a], bAnim = animState?.[b];
              const ax = aAnim?.x ?? basePos(a).x, ay = aAnim?.y ?? basePos(a).y;
              const bx = bAnim?.x ?? basePos(b).x, by = bAnim?.y ?? basePos(b).y;
              const aOp = aAnim?.opacity ?? 1;
              const bOp = bAnim?.opacity ?? 1;
              const edgeOp = Math.min(aOp, bOp) * (hi ? 0.7 : !connected ? 0.18 : 0.05);

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
                    stroke={hi ? PURPLE : "#2a3a5a"}
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
              const filterAttr = pulse > 0.05
                ? "url(#pulse-filter)"
                : glow > 0.3
                  ? `url(#glow-${n.type})`
                  : undefined;

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
                  {/* Outer glow ring when selected */}
                  {isSel && (
                    <circle r={r+10} fill="none"
                      stroke={c.fill} strokeWidth="1.5" strokeOpacity={0.3 + glow*0.3}/>
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
                    filter={filterAttr}
                  />
                  {hasPr && !isSel && (
                    <circle r={4} cx={r-3} cy={-(r-3)}
                      fill="#378ADD" stroke="#0a0f1e" strokeWidth="1.5"/>
                  )}
                  {lines.map((ln,i)=>(
                    <text key={i} textAnchor="middle" dy={startY+i*lh+fs*0.38}
                      fontSize={fs} fontWeight={isSel?700:500} fill={c.text}
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
              maxWidth:220, background:"#0d1325",
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
                  width:10, height:10, background:"#0d1325",
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
            <div style={{position:"absolute",top:10,left:10,zIndex:10,display:"flex",alignItems:"center",gap:4,background:"rgba(13,19,37,0.9)",backdropFilter:"blur(6px)",border:"1px solid #1a2540",borderRadius:8,padding:"5px 10px",flexWrap:"wrap"}}>
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
            <div style={{position:"absolute",bottom:12,left:"50%",transform:"translateX(-50%)",background:"rgba(13,19,37,0.85)",backdropFilter:"blur(6px)",border:"1px solid #1a2540",borderRadius:20,padding:"6px 16px",fontSize:12,color:"#64748b",pointerEvents:"none",whiteSpace:"nowrap"}}>
              Click any node to explore · <span style={{color:"#378ADD"}}>●</span> = has guided practice
            </div>
          )}
        </div>

        {/* Drag divider — tap to toggle, drag to resize */}
        {selectedNode && !panelCollapsed && (
          <div
            onMouseDown={onDividerMouseDown}
            onTouchStart={onDividerTouchStart}
            style={{
              width: 24, flexShrink: 0, cursor: "col-resize", zIndex: 25,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "#0d1325", borderLeft: "1px solid #1a2540",
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
              background: "#0d1325", borderLeft: "1px solid #1a2540",
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
            background: "#0d1325",
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
              <div style={{padding:"16px 16px 0",position:"relative",flexShrink:0,background:"#0d1325",zIndex:2}}>
                <button style={{position:"absolute",top:14,right:14,background:"none",border:"none",color:"#475569",cursor:"pointer",fontSize:18,lineHeight:1,fontFamily:"inherit"}} onClick={clearAll}>✕</button>
                <div style={{fontSize:10.5,fontWeight:600,letterSpacing:".08em",textTransform:"uppercase",color:COLORS[selectedNode.type]?.fill,marginBottom:3}}>{COLORS[selectedNode.type]?.typeLabel}</div>
                <div style={{fontSize:17,fontWeight:600,color:"#f1f5f9",lineHeight:1.25,marginBottom:12,paddingRight:24,letterSpacing:"-0.02em"}}>{selectedNode.full||selectedNode.label.replace("\n"," ")}</div>
                {/* Tabs */}
                <div style={{display:"flex",borderBottom:"1px solid #1a2540",overflowX:"auto"}}>
                  {["overview", ...(hasHistory?["history"]:[]), ...(hasLinks?["links"]:[]), ...(hasPractice?["practice"]:[]), ...(hasTips?["tips"]:[]), "insight"].map(t=>(
                    <button key={t} style={{flexShrink:0,padding:"8px 10px",background:"none",border:"none",borderBottom:`2px solid ${tab===t?"#7F77DD":"transparent"}`,color:tab===t?"#e2e8f0":"#64748b",cursor:"pointer",fontSize:12,fontWeight:tab===t?600:400,fontFamily:"inherit",whiteSpace:"nowrap"}}
                      onClick={()=>setTab(t)}>
                      {t==="overview"?"Overview":t==="history"?"⏱ History":t==="links"?"🔗 Links":t==="tips"?"💡 Tips":t==="practice"?"▶ Practice":"✦ AI insight"}
                    </button>
                  ))}
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
                    <div style={{fontSize:13,lineHeight:1.75,color:"#cbd5e1",whiteSpace:"pre-line",background:"#080c18",borderRadius:8,padding:"12px 14px",marginBottom:14,border:"1px solid #1a2540"}}>{selectedNode.content}</div>

                    {/* IFS character feed — Instagram-style swipeable cards */}
                    {selected === "ifs" && (
                      <div style={{marginBottom:14}}>
                        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                          <p style={{fontSize:10.5,fontWeight:600,letterSpacing:".07em",textTransform:"uppercase",color:"#475569",margin:0}}>Meet the parts</p>
                          <button onClick={()=>setOverviewFullscreen(true)} style={{
                            display:"flex",alignItems:"center",gap:4,background:"none",border:"1px solid #1a2540",
                            borderRadius:7,padding:"4px 9px",color:"#94a3b8",fontSize:11,cursor:"pointer",fontFamily:"inherit"
                          }}>
                            ⤢ Fullscreen
                          </button>
                        </div>
                        <IFSFeed fullscreen={false}/>
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
                      ? <div style={{width:28,height:28,border:"2px solid #1a2540",borderTop:"2px solid #7F77DD",borderRadius:"50%",animation:"spin .7s linear infinite",margin:"48px auto"}}/>
                      : insight
                        ? <>
                            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,paddingBottom:12,borderBottom:"1px solid #1a2540"}}>
                              <span style={{fontSize:12,color:"#7F77DD",fontWeight:600}}>✦</span>
                              <span style={{fontSize:11,color:"#475569",letterSpacing:".06em",textTransform:"uppercase",fontWeight:600}}>Claude · Clinical insight</span>
                            </div>
                            <p style={{fontSize:13.5,lineHeight:1.8,color:"#cbd5e1",whiteSpace:"pre-wrap",margin:0}}>{insight}</p>
                            <button onClick={()=>{insightCache.current[selected]="";generateInsight();}}
                              style={{marginTop:16,padding:"7px 14px",background:"transparent",border:"1px solid #1a2540",borderRadius:7,color:"#64748b",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>
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
          background:"#0a0f1e", display:"flex", flexDirection:"column",
          overflowY:"auto", WebkitOverflowScrolling:"touch",
        }}>
          <div style={{
            display:"flex", alignItems:"center", gap:10, padding:"14px 16px",
            borderBottom:"1px solid #1a2540", flexShrink:0, position:"sticky", top:0,
            background:"#0a0f1e", zIndex:2,
          }}>
            <button onClick={()=>setOverviewFullscreen(false)} style={{
              display:"flex", alignItems:"center", gap:6, background:"none",
              border:"1px solid #1a2540", borderRadius:8, padding:"6px 12px",
              color:"#94a3b8", fontSize:13, cursor:"pointer", fontFamily:"inherit"
            }}>‹ Back to map</button>
            <span style={{fontSize:13, fontWeight:600, color:"#f1f5f9"}}>
              {selectedNode.full || selectedNode.label.replace("\n"," ")}
            </span>
          </div>
          <div style={{flex:1, padding:"24px 16px 60px"}}>
            <IFSFeed fullscreen={true}/>
          </div>
        </div>
      )}
    </div>
  );
}
