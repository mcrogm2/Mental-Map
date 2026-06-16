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
  init(nodes, sizes) {
    nodes.forEach(n => {
      const r = sizes[n.id] ?? 22;
      this.targets[n.id]  = { opacity:1, radius:r, glow:0, pulse:0 };
      this.current[n.id]  = { opacity:1, radius:r, glow:0, pulse:0 };
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
          ? ["opacity","radius","pulse"]
          : ["opacity","radius","glow","pulse"];
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

// ── History panel ──────────────────────────────────────────────────────────────
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

// ── Compute base sizes (full-map, module-level) ────────────────────────────────
const { sizes: NODE_SIZES, degree: NODE_DEGREE } = computeNodeSizes(NODES, EDGES);

// Singleton animator — lives outside React
const animator = new NodeAnimator();

// ── Main ───────────────────────────────────────────────────────────────────────
export default function MentalMap() {
  const [selected, setSelected]   = useState(null);
  const [breadcrumb, setBreadcrumb] = useState([]);
  const [tab, setTab]             = useState("overview");
  const [insight, setInsight]     = useState("");
  const [loading, setLoading]     = useState(false);
  const insightCache = useRef({});
  const [tooltip, setTooltip]     = useState(null);
  // Animated node state (updated by animator outside React render)
  const [animState, setAnimState] = useState(null);
  const svgRef = useRef(null);
  const selectedRef = useRef(null);

  // Init animator once
  useEffect(() => {
    animator.init(NODES, NODE_SIZES);
    const unsub = animator.subscribe(state => setAnimState({...state}));
    return () => { unsub(); animator.destroy(); };
  }, []);

  // ── Cluster centering ──────────────────────────────────────────────────────
  const [viewBox, setViewBox] = useState("0 0 900 630");

  const recenterCluster = useCallback((id) => {
    const cluster = new Set([id]);
    EDGES.forEach(([a,b]) => { if(a===id) cluster.add(b); if(b===id) cluster.add(a); });
    const clusterNodes = NODES.filter(n => cluster.has(n.id));
    if (!clusterNodes.length) return;
    const xs = clusterNodes.map(n=>n.x), ys = clusterNodes.map(n=>n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const padX = 80, padY = 80;
    const cx = (minX+maxX)/2, cy = (minY+maxY)/2;
    const spanX = Math.max(maxX-minX+padX*2, 300);
    const spanY = Math.max(maxY-minY+padY*2, 300);
    // Keep aspect ratio, zoom in but not too much
    const scale = Math.min(900/spanX, 630/spanY, 1.6);
    const vw = 900/scale, vh = 630/scale;
    const vx = cx - vw/2, vy = cy - vh/2;
    setViewBox(`${vx} ${vy} ${vw} ${vh}`);
  }, []);

  const resetViewBox = useCallback(() => {
    setViewBox("0 0 900 630");
  }, []);

  // ── Selection with staged animation ───────────────────────────────────────
  const selectNode = useCallback((id) => {
    if (id === selectedRef.current) { clearAll(); return; }
    selectedRef.current = id;
    setSelected(id);
    setTab("overview");
    setInsight(insightCache.current[id] || "");
    setBreadcrumb(prev => [...prev.filter(x=>x!==id).slice(-3), id]);
    animator.stopBreathe(); // stop any previous breathe immediately

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

    // Stage 3 (220ms): rescale to cluster-relative sizes
    setTimeout(() => {
      const clusterSizes = computeClusterSizes(id, NODES, EDGES, DEGREE_RANGES);
      const resize = {};
      NODES.forEach(n => { resize[n.id] = { radius: clusterSizes[n.id] }; });
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
    setInsight("");
    setTooltip(null);
    animator.stopBreathe();

    // Reset all nodes to base state
    const reset = {};
    NODES.forEach(n => {
      reset[n.id] = { opacity:1, radius: NODE_SIZES[n.id] ?? 22, glow:0, pulse:0 };
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

  const clusterLabels = [
    {x:50,  y:22, text:"Therapy modalities", color:COLORS.modality.fill},
    {x:310, y:22, text:"Core concepts",       color:COLORS.concept.fill},
    {x:635, y:22, text:"Life challenges",     color:COLORS.challenge.fill},
  ];

  return (
    <div style={{fontFamily:"'Inter','Helvetica Neue',sans-serif",background:"#0a0f1e",minHeight:"100vh",display:"flex",flexDirection:"column",color:"#e2e8f0"}}>
      <style>{`
        @keyframes spin { to { transform:rotate(360deg) } }
        .map-svg { transition: all 0s; }
        svg text { pointer-events:none; user-select:none; }
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
      <div style={{flex:1,display:"flex",overflow:"hidden"}}>

        {/* Canvas */}
        <div style={{flex:1,position:"relative",overflow:"hidden"}}>
          <svg ref={svgRef}
            viewBox={viewBox}
            style={{width:"100%",height:"100%",display:"block",transition:"viewBox 0.5s ease"}}
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

            <rect width="1800" height="1260" x="-450" y="-315" fill="#0a0f1e"/>

            {/* Cluster labels */}
            {clusterLabels.map(l=>(
              <text key={l.text} x={l.x} y={l.y} fontSize="10.5" fontWeight="500"
                fill={l.color} opacity={selected ? 0 : 0.65}
                fontFamily="Inter,sans-serif"
                style={{transition:"opacity 0.4s ease"}}>
                {l.text}
              </text>
            ))}

            {/* Edges */}
            {EDGES.map(([a,b],i)=>{
              const na=nodeById(a), nb=nodeById(b); if(!na||!nb) return null;
              const hi = connected && connected.has(a) && connected.has(b);
              const aOp = animState ? (animState[a]?.opacity??1) : 1;
              const bOp = animState ? (animState[b]?.opacity??1) : 1;
              const edgeOp = Math.min(aOp, bOp) * (hi ? 0.7 : !connected ? 0.18 : 0.05);
              return (
                <line key={i}
                  x1={na.x} y1={na.y} x2={nb.x} y2={nb.y}
                  stroke={hi ? "#7F77DD" : "#2a3a5a"}
                  strokeWidth={hi ? 2 : 1}
                  strokeOpacity={edgeOp}
                />
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
                  transform={`translate(${n.x},${n.y})`}
                  opacity={op}
                  style={{cursor: op < 0.05 ? "default" : "pointer"}}
                  onClick={() => op > 0.05 && selectNode(n.id)}
                  onMouseEnter={e => {
                    if (op < 0.1) return;
                    const svg = e.currentTarget.closest("svg");
                    const rect = svg.getBoundingClientRect();
                    const wrap = svg.parentElement.getBoundingClientRect();
                    // Parse current viewBox for accurate coord mapping
                    const vb = viewBox.split(" ").map(Number);
                    const scaleX = rect.width / vb[2];
                    const scaleY = rect.height / vb[3];
                    const px = rect.left - wrap.left + (n.x - vb[0]) * scaleX;
                    const py = rect.top  - wrap.top  + (n.y - vb[1]) * scaleY - r * scaleY - 12;
                    setTooltip({ x:px, y:py, name: n.full||n.label.replace("\n"," "), text: n.summary||"", color: c.fill });
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

          {/* Custom tooltip */}
          {tooltip && (
            <div style={{
              position:"absolute", left:tooltip.x, top:tooltip.y,
              transform:"translate(-50%,-100%)", pointerEvents:"none", zIndex:50,
              maxWidth:220, background:"#0d1325",
              border:`1px solid ${tooltip.color}55`, borderRadius:10,
              padding:"9px 12px", boxShadow:"0 4px 20px rgba(0,0,0,0.5)",
            }}>
              <p style={{fontSize:11,fontWeight:600,color:tooltip.color,margin:"0 0 4px",letterSpacing:".04em",textTransform:"uppercase",lineHeight:1.3}}>{tooltip.name}</p>
              <p style={{fontSize:12.5,color:"#cbd5e1",margin:0,lineHeight:1.6}}>{tooltip.text}</p>
              <div style={{position:"absolute",bottom:-6,left:"50%",transform:"translateX(-50%)",width:10,height:6,overflow:"hidden"}}>
                <div style={{width:10,height:10,background:"#0d1325",border:`1px solid ${tooltip.color}55`,transform:"rotate(45deg)",transformOrigin:"top left",marginTop:3}}/>
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

        {/* Detail Panel */}
        <div style={{width:selectedNode?340:0,flexShrink:0,overflow:"hidden",transition:"width .25s ease",background:"#0d1325",borderLeft:"1px solid #1a2540",display:"flex",flexDirection:"column"}}>
          <div style={{width:340,display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
            {selectedNode && <>
              <div style={{padding:"16px 16px 0",position:"relative",flexShrink:0}}>
                <button style={{position:"absolute",top:14,right:14,background:"none",border:"none",color:"#475569",cursor:"pointer",fontSize:18,lineHeight:1,fontFamily:"inherit"}} onClick={clearAll}>✕</button>
                <div style={{fontSize:10.5,fontWeight:600,letterSpacing:".08em",textTransform:"uppercase",color:COLORS[selectedNode.type]?.fill,marginBottom:3}}>{COLORS[selectedNode.type]?.typeLabel}</div>
                <div style={{fontSize:17,fontWeight:600,color:"#f1f5f9",lineHeight:1.25,marginBottom:12,paddingRight:24,letterSpacing:"-0.02em"}}>{selectedNode.full||selectedNode.label.replace("\n"," ")}</div>
                <div style={{display:"flex",borderBottom:"1px solid #1a2540",overflowX:"auto"}}>
                  {["overview", ...(hasHistory?["history"]:[]), ...(hasPractice?["practice"]:[]), "insight"].map(t=>(
                    <button key={t} style={{flexShrink:0,padding:"8px 10px",background:"none",border:"none",borderBottom:`2px solid ${tab===t?"#7F77DD":"transparent"}`,color:tab===t?"#e2e8f0":"#64748b",cursor:"pointer",fontSize:12,fontWeight:tab===t?600:400,fontFamily:"inherit",whiteSpace:"nowrap"}}
                      onClick={()=>setTab(t)}>
                      {t==="overview"?"Overview":t==="history"?"⏱ History":t==="practice"?"▶ Practice":"✦ AI insight"}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{flex:1,overflowY:"auto",padding:16}}>
                {tab==="overview" && (
                  <div>
                    <p style={{fontSize:13.5,lineHeight:1.7,color:"#94a3b8",marginBottom:14}}>{selectedNode.summary}</p>
                    <div style={{fontSize:13,lineHeight:1.75,color:"#cbd5e1",whiteSpace:"pre-line",background:"#080c18",borderRadius:8,padding:"12px 14px",marginBottom:14,border:"1px solid #1a2540"}}>{selectedNode.content}</div>
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
              </div>
            </>}
          </div>
        </div>
      </div>
    </div>
  );
}
