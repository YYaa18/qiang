"use strict";

// 我说你画 —— 一个人拿到词，只能用话把它描述出来；别人照着画。
//
// 关键在于拿词的人**不能说出那个词**，也不能自己动笔。于是只剩下形状、方位、大小：
// 「先画一个长方形，左边伸出两条腿」。画的人一路蒙在鼓里，揭晓那一刻才知道
// 自己画的是什么——落差就在那里。
//
// 人数：2 人是标准形态（1 说 1 画），3–4 人时 1 说 3 画，画完并排看更热闹。
// 拿词的人和接龙的笔一样是一根**接力棒**：可以没人拿着（teller 为 null），
// 谁来了谁接；拿词的人中途走了，词就放回墙上，这局不会卡死。
//
// 这个玩法没有用到 visible——画的东西本来就该让说的人看见，他得随时纠正你。
// 秘密只有一个词，而它从一开始就只发给一个人：publicState 是按人调用的。

const { pushSystem } = require("../wall/chat");
const presence = require("../wall/presence");
const { register } = require("./index");

const { pickWord } = require("./words");

// 说的人不能说出词本身，也不能拆开来说。
// 两个字以上的片段都禁掉：「长颈鹿」里的「长颈」「颈鹿」一并算数，
// 逼得人只能说形状。单个字不禁——「大」「人」这种常用字禁了就没法说话了。
function bannedBits(word) {
  const chars = [...word];
  const out = new Set([word]);
  for (let n = 2; n < chars.length; n++) {
    for (let i = 0; i + n <= chars.length; i++) out.add(chars.slice(i, i + n).join(""));
  }
  return [...out];
}

function saidTheWord(word, text) {
  const clean = String(text || "").replace(/\s+/g, "");
  return bannedBits(word).some((bit) => clean.includes(bit));
}

function nameOf(room, id) {
  const u = room.users.get(id);
  return u ? u.name : "某人";
}

// 揭晓即这局的终点：说出谜底，然后把玩法摘掉，墙回到平常的样子
function finish(room, api) {
  const word = room.mode.word;
  room.mode.revealed = true;
  api.end();
  presence.resend(room, { reveal: "我说你画" });
  pushSystem(room, `谜底是「${word}」`);
}

module.exports = register({
  id: "tell",
  name: "我说你画",
  hint: "一个人拿到词只能靠嘴说，其他人照着画，画的人到最后才知道画的是什么",

  init(room, user, msg, api) {
    room.mode.word = pickWord(null);
    room.mode.teller = user.id;
    room.mode.revealed = false;
    pushSystem(room, `${user.name}拿到了词，接下来只能听他说`);
    api.announce();
  },

  stop(room, user, api) {
    finish(room, api);
  },

  can(room, user, action, msg) {
    const m = room.mode;
    const isTeller = m.teller === user.id;

    if (action === "draw" || action === "text") {
      if (isTeller) return "你是说的人，画的事交给别人";
      if (!m.teller) return "还没有人拿到词，等一下";
      return null;
    }

    // 说的人把词说漏了：拦下来，别让这局就这么废了
    if (action === "chat" && isTeller && msg && saidTheWord(m.word, msg.text)) {
      return "这几个字不能说，换个说法——只说形状";
    }
    return null;
  },

  on(room, event, api) {
    // 拿词的人走了：词放回墙上，谁来谁接，两人局掉一个人也不卡死
    if (event.type === "leave" && room.mode.teller === event.userId) {
      room.mode.teller = null;
      pushSystem(room, "拿词的人走了，词放回了墙上");
      api.announce();
      return;
    }
    if (event.type === "join") api.announce();
  },

  command(room, user, cmd, msg, api) {
    const m = room.mode;

    if (cmd === "take") {
      if (m.teller) return;
      m.teller = user.id;
      m.word = pickWord(m.word); // 换一个：上一个人已经看过了
      pushSystem(room, `${user.name}接过了词`);
      api.announce();
      return;
    }

    if (cmd === "another") {
      if (m.teller !== user.id) return;
      m.word = pickWord(m.word);
      pushSystem(room, "换了一个词");
      api.announce();
      return;
    }

    if (cmd === "reveal") {
      if (user.id !== room.hostId && user.id !== m.teller) return;
      if (m.revealed) return;
      finish(room, api);
    }
  },

  // 词只发给拿着它的那一个人。这个函数是按人调用的，所以私密就在这里成立。
  publicState(room, user) {
    const m = room.mode;
    const isTeller = m.teller === user.id;
    const host = room.hostId === user.id;
    const reveal = { cmd: "reveal", label: "揭晓", confirm: "现在揭晓？谜底会公布给所有人。" };

    if (isTeller) {
      return {
        label: `你要让他们画出：${m.word}`,
        tone: "you",
        word: m.word, // 只有这一支返回里有词
        action: { cmd: "another", label: "换个词" },
        blocked: true,
        why: "你是说的人，画的事交给别人",
        hostActions: [reveal],
      };
    }
    if (!m.teller) {
      return {
        label: "词还在墙上，没人拿着",
        tone: "free",
        action: { cmd: "take", label: "我来说" },
        blocked: true,
        why: "还没有人拿到词",
        hostActions: host ? [reveal] : [],
      };
    }
    return {
      label: `${nameOf(room, m.teller)}在说，你来画`,
      tone: "wait",
      blocked: false,
      hostActions: host ? [reveal] : [],
    };
  },

  restore(room) {
    if (!room.mode.word) room.mode.word = pickWord(null);
    room.mode.revealed = !!room.mode.revealed;
  },
});
