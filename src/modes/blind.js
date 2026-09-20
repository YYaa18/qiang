"use strict";

// 盲画 —— 你画的东西，只有你自己看不见。
//
// 没有轮次，没有限额，谁都可以随时画。唯一的规则是：你的笔落下去，纸上什么也不出现。
// 别人看得一清二楚（这正是好玩的地方），只有你在凭手感摸黑画。
// 房主揭晓，你才第一次看见自己干了什么。
//
// 可见性规则和接龙**正好相反**：
//   接龙   自己画的总看得见，别人画的看不见
//   盲画   别人画的都看得见，只有自己画的看不见
//
// 同一个 visible 钩子，两条相反的规则，这一层就算立住了。
//
// 「自己看不见」要两边配合：
//   服务端  不把你的笔画发回给你（藏在前端等于没藏，何况快照也得干净）
//   客户端  publicState 里的 hideOwnInk 让它别渲染本地那份乐观副本

const { pushSystem } = require("../wall/chat");
const presence = require("../wall/presence");
const { register } = require("./index");

// 揭晓即这局的终点：把画交还给所有人，然后把玩法摘掉，墙回到平常的样子
function finish(room, api) {
  room.mode.revealed = true;
  api.end();
  presence.resend(room);
  pushSystem(room, "盲画揭晓了，看看自己画的是什么");
}

module.exports = register({
  id: "blind",
  name: "盲画",
  hint: "你画的自己看不见，别人看得一清二楚，揭晓时才显形",

  init(room, user, msg, api) {
    room.mode.revealed = false;
    pushSystem(room, "盲画开始了，放心画，你看不见的");
    api.announce();
  },

  stop(room, user, api) {
    finish(room, api);
  },

  visible(room, user, stroke) {
    if (room.mode.revealed) return true;
    return stroke.userId !== user.id; // 只有自己画的看不见
  },

  publicState(room, user) {
    const host = room.hostId === user.id;
    return {
      label: "你画的自己看不见",
      tone: "you",
      hideOwnInk: true, // 客户端据此不渲染自己的笔迹，连正在画的那一笔也不渲染
      hostActions: host
        ? [{ cmd: "reveal", label: "揭晓", confirm: "现在揭晓？大家都会看到自己画的是什么。" }]
        : [],
    };
  },

  command(room, user, cmd, msg, api) {
    if (cmd !== "reveal") return;
    if (user.id !== room.hostId) return;
    if (room.mode.revealed) return;
    finish(room, api);
  },

  restore(room) {
    room.mode.revealed = !!room.mode.revealed;
  },
});
