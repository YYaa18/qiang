"use strict";

// 传话筒 —— 画 → 说 → 画 → 说，每个人只看得见上一步。
//
// 第一个人拿到一个词，画在一段新纸上；下一个人只看得见这幅画，用一句话说出它画的是什么；
// 再下一个人只看得见这句话，照着画在又一段新纸上……揭晓时整条卷轴连同每一步的话一起摊开，
// 看「长颈鹿」是怎么一步步传成「戴围巾的路灯」的。
//
// 文档原本把它判成「2 人玩不了、得同时在线」——那是按一圈人各传一次的玩法想的。
// 这里每一步都是一根**接力棒**，和接龙一样可以放在墙上没人拿着，谁来谁接，
// 唯一的规矩是**不能接自己上一步的棒**（不能自己画了又自己说）。于是：
//   1 人   画一幅留在墙上，等下一个推门进来的人
//   2 人   乒乓着来回传，链想拉多长拉多长
//   3–4 人  谁有空谁接，一晚上传出一长串
//
// 秘密有两种，走的是两条现成的路：
//   - 画：用可见性钩子藏。一段纸只有画它的人、以及被派来看它的那个人看得见
//   - 话：只放在下一个画的人的 publicState 里（按人调用，和我说你画的词一样）
//
// 写那一句话不能走聊天（聊天大家都看得见），所以横幅上的按钮可以带一个输入框
// （action.input）——这是通用的显示指令，客户端不认识「传话筒」。
//
// 接棒会改变谁看得见什么（看画的人突然该看见那幅画了），那几笔落下时他还看不见、没收到过，
// 所以接棒时重发整墙。接龙原先就漏了这一步，这次一起补上了。

const { SEG_W, CANVAS_H } = require("../config");
const { send } = require("../net");
const { pushSystem } = require("../wall/chat");
const presence = require("../wall/presence");
const { placeStroke } = require("../wall/draw");
const { pickWord } = require("./words");
const { register } = require("./index");

const TEXT_MAX = 30;

function nameOf(room, id) {
  const u = room.users.get(id);
  return u ? u.name : "某人";
}

function steps(room) {
  return room.mode.steps || [];
}

function current(room) {
  const list = steps(room);
  return list.length ? list[list.length - 1] : null;
}

// 上一步是谁做的：接棒的人不能是他
function prevAuthor(room) {
  const list = steps(room);
  return list.length >= 2 ? list[list.length - 2].by : null;
}

function canTake(room, user) {
  const cur = current(room);
  return !room.mode.holder && !!cur && !cur.done && prevAuthor(room) !== user.id;
}

function rangeOf(seg) {
  return { x0: seg * SEG_W, x1: (seg + 1) * SEG_W };
}

// 一笔落在哪一段：按横向中点算。文字量不了宽，按每字 22px 估
function segOf(stroke) {
  let x0;
  let x1;
  if (stroke.type === "text") {
    x0 = stroke.x;
    x1 = stroke.x + [...(stroke.text || "")].length * 22;
  } else {
    const xs = (stroke.points || []).map((p) => p.x);
    if (!xs.length) return -1;
    x0 = Math.min(...xs);
    x1 = Math.max(...xs);
  }
  return Math.floor((x0 + x1) / 2 / SEG_W);
}

function clean(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TEXT_MAX);
}

// 揭晓：把每一步的话写到卷轴上，再把整条卷轴交还给所有人
function finish(room, api) {
  const m = room.mode;
  m.revealed = true; // 先打开可见性，下面放上去的字每个人都收得到
  const ink = "#1A1A1A";
  for (const [i, st] of steps(room).entries()) {
    const x = st.seg * SEG_W + 28;
    const who = st.byName || (st.by ? nameOf(room, st.by) : "");
    if (st.kind === "draw") {
      let text;
      if (i === 0) text = `题目「${st.prompt}」${who ? ` · ${who}画的` : ""}`;
      else if (st.done) text = `${who}照着「${st.prompt}」画的`;
      else text = `「${st.prompt}」还没人画完`;
      placeStroke(room, { type: "text", x, y: 22, text, color: ink });
    } else if (st.done) {
      placeStroke(room, { type: "text", x, y: CANVAS_H - 50, text: `${who}看成了「${st.text}」`, color: ink });
    }
  }
  const first = steps(room)[0];
  const said = steps(room).filter((st) => st.kind === "write" && st.done);
  api.end();
  presence.resend(room, { reveal: "传话筒" });
  if (said.length) pushSystem(room, `传话筒揭晓了：「${first.prompt}」传到最后成了「${said[said.length - 1].text}」`);
  else pushSystem(room, `传话筒揭晓了：题目是「${first.prompt}」，还没传出去`);
}

module.exports = register({
  id: "phone",
  name: "传话筒",
  hint: "画 → 说 → 画 → 说，每人只看得见上一步，揭晓时看它传成了什么",

  init(room, user, msg, api) {
    const m = room.mode;
    m.from = room.nextSeq - 1; // 开局之前墙上已有的，照常看得见
    m.revealed = false;
    const seg = presence.freshPaper(room, user.id);
    m.steps = [{ kind: "draw", seg, prompt: pickWord(null), by: user.id, done: false }];
    m.holder = user.id;
    pushSystem(room, `传话筒开始了，${user.name}先画`);
    api.announce();
  },

  // 中途结束也等于揭晓：不然那些藏起来的画谁也看不到了
  stop(room, user, api) {
    finish(room, api);
  },

  can(room, user, action, msg) {
    const m = room.mode;
    if (m.revealed) return null;
    if (action === "extend") return "传话筒的时候墙会自己接长";
    const cur = current(room);
    const mine = m.holder === user.id;
    if (action === "draw" || action === "text") {
      if (!mine) return m.holder ? `现在轮到${nameOf(room, m.holder)}` : "先接过来才能画";
      if (cur.kind !== "draw") return "现在是写一句话的时候，不是画";
      const x = Number(msg && (msg.x ?? (msg.point && msg.point.x)));
      const r = rangeOf(cur.seg);
      if (Number.isFinite(x) && (x < r.x0 || x > r.x1)) return "只能画在这一段纸上";
      return null;
    }
    if (action === "undo" || action === "redo") {
      return mine && cur.kind === "draw" ? null : "现在不是你在画";
    }
    return null;
  },

  // 一段纸只有画它的人、被派来看它的人看得见；开局前墙上已有的照常看得见
  visible(room, user, stroke) {
    const m = room.mode;
    if (m.revealed) return true;
    if (stroke.seq <= m.from) return true;
    if (stroke.userId === user.id) return true;
    const seg = segOf(stroke);
    return steps(room).some((st) => st.seg === seg && st.by === user.id);
  },

  publicState(room, user) {
    const m = room.mode;
    const cur = current(room);
    const mine = m.holder === user.id;
    const host = room.hostId === user.id;
    const base = {
      stepCount: steps(room).length, // 传到第几步了，不是秘密
      noExtend: true,
      hostActions: host ? [{ cmd: "reveal", label: "揭晓", confirm: "现在揭晓？整条卷轴和每一步的话都会摊开。" }] : [],
    };

    if (mine && cur.kind === "draw") {
      return {
        ...base,
        label: `照着画：「${cur.prompt}」`, // 只有他看得见这句话
        tone: "you",
        action: { cmd: "pass", label: "画完了，交出去" },
        blocked: false,
        drawable: rangeOf(cur.seg),
      };
    }
    if (mine && cur.kind === "write") {
      return {
        ...base,
        label: "这画的是什么？用一句话说出来",
        tone: "you",
        action: { cmd: "write", label: "交出去", input: { placeholder: "比如：戴围巾的长颈鹿在滑雪", max: TEXT_MAX } },
        blocked: true,
        why: "现在是写一句话的时候，不是画",
        // 不是让他画，是把镜头带到要看的那幅画上、别处盖起来——落笔已经被 blocked 拦住了
        drawable: rangeOf(cur.seg),
      };
    }
    if (!m.holder) {
      if (canTake(room, user)) {
        return {
          ...base,
          label: cur.kind === "draw" ? "有一句话等人来画" : "有一幅画等人来看",
          tone: "free",
          action: { cmd: "take", label: "我来接" },
          blocked: true,
          why: "先接过来",
        };
      }
      return {
        ...base,
        label: "上一步是你做的，等别人来接",
        tone: "wait",
        blocked: true,
        why: "上一步是你做的，等别人来接",
      };
    }
    const who = nameOf(room, m.holder);
    return {
      ...base,
      label: cur.kind === "draw" ? `${who}正在画` : `${who}正在看一幅画，想一句话`,
      tone: "wait",
      blocked: true,
      why: `现在轮到${who}`,
    };
  },

  command(room, user, cmd, msg, api) {
    const m = room.mode;
    if (m.revealed) return;
    const cur = current(room);

    if (cmd === "take") {
      if (!canTake(room, user)) return;
      m.holder = user.id;
      cur.by = user.id;
      pushSystem(room, `${user.name}接过了${cur.kind === "draw" ? "那句话" : "那幅画"}`);
      // 看画的人现在该看见那幅画了——那几笔落下时他还看不见，从没收到过
      presence.resend(room);
      api.announce();
      return;
    }

    if (cmd === "pass") {
      if (m.holder !== user.id || cur.kind !== "draw") return;
      const drew = room.strokes.some((s) => !s.hidden && s.seq > m.from && segOf(s) === cur.seg);
      if (!drew) {
        send(user.ws, { type: "error", code: "not_allowed", message: "至少画一笔再交出去" });
        return;
      }
      cur.done = true;
      cur.byName = user.name;
      m.steps.push({ kind: "write", seg: cur.seg, by: null, done: false });
      m.holder = null;
      pushSystem(room, `${user.name}画完了，等人来看看它画的是什么`);
      api.announce();
      return;
    }

    if (cmd === "write") {
      if (m.holder !== user.id || cur.kind !== "write") return;
      const text = clean(msg.text);
      if (!text) {
        send(user.ws, { type: "error", code: "not_allowed", message: "写一句话再交出去" });
        return;
      }
      cur.text = text;
      cur.done = true;
      cur.byName = user.name;
      const seg = presence.freshPaper(room, user.id); // 刚才那段有画了，这里总会接一段新的
      m.steps.push({ kind: "draw", seg, prompt: text, by: null, done: false });
      m.holder = null;
      pushSystem(room, `${user.name}写好了一句话，等人来照着画`);
      api.announce();
      return;
    }

    if (cmd === "reveal") {
      if (user.id !== room.hostId) return;
      finish(room, api);
    }
  },

  on(room, event, api) {
    const m = room.mode;
    if (m.revealed) return;
    // 拿着棒的人走了：棒放回墙上。画了一半的留着，接手的人看得见、接着画
    if (event.type === "leave" && m.holder === event.userId) {
      m.holder = null;
      current(room).by = null;
      pushSystem(room, "拿着棒的人走了，棒放回了墙上");
      api.announce();
      return;
    }
    if (event.type === "join") api.announce();
  },

  restore(room) {
    // 没有定时器。棒在墙上放一整夜是这个玩法的常态
    if (!Array.isArray(room.mode.steps)) room.mode.steps = [];
  },
});
