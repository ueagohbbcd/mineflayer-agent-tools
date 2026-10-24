import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startChatLog, summarize } from "../../runtime/default-scripts/chat.mjs";

function nativeBot(username = "arena_red1") {
  return Object.assign(new EventEmitter(), { username });
}

function setup(options = {}) {
  const posted = [];
  const log = { post: async (data, opts) => posted.push({ data, ...opts }) };
  const bot = nativeBot(options.username);
  const chat = startChatLog({ bot, log, ...options });
  return { posted, bot, chat };
}

test("chat and whispers are logged one entry a line, as the game gave them", async () => {
  const { posted, bot, chat } = setup();
  bot.emit("chat", "player", "same");
  bot.emit("chat", "player", "same");
  bot.emit("whisper", "player", "secret");
  await chat.flush();
  assert.deepEqual(
    posted.map((p) => [p.type, p.data.sender, p.data.text, p.urgent ?? false]),
    [
      ["chat", "player", "same", false],
      ["chat", "player", "same", false],
      ["whisper", "player", "secret", false],
    ],
  );
  await chat.close();
  bot.emit("chat", "player", "after close");
  assert.equal(posted.length, 3);
  assert.equal(bot.listenerCount("chat"), 0);
  assert.equal(bot.listenerCount("whisper"), 0);
});

test("mention wake rules: names, whispers, own lines and regex characters", async () => {
  const { posted, bot, chat } = setup({ username: "arena.red", wake: "mention" });
  // Mineflayer passes the sender and the body without the "<name>" prefix.
  bot.emit("chat", "player", "hello arenaXred");
  bot.emit("chat", "player", "hello arena.red!");
  bot.emit("whisper", "player", "private message");
  bot.emit("chat", "arena.red", "arena.red says hello");
  bot.emit("whisper", "arena.red", "to myself");
  await chat.flush();
  assert.deepEqual(
    posted.map((p) => [p.type, p.data.text, p.urgent ?? false]),
    [
      ["chat", "hello arenaXred", false],
      ["chat", "hello arena.red!", true],
      ["whisper", "private message", true],
    ],
  );
  await chat.close();
});

test("system lines are logged without waking; action-bar lines are not", async () => {
  const { posted, bot, chat } = setup({ username: "arena.red", wake: "all" });
  bot.emit("messagestr", "Respawn point set", "system");
  bot.emit("messagestr", "You may not rest now", "game_info");
  bot.emit("messagestr", "<player> hi", "chat");
  await chat.flush();
  assert.deepEqual(
    posted.map((p) => [p.type, p.data.text, p.data.sender, p.urgent ?? false]),
    [["system", "Respawn point set", null, false]],
  );
  await chat.close();
  assert.equal(bot.listenerCount("messagestr"), 0);
});

test("mf log shows chat as the game does, marked as other players' words", () => {
  const at = Date.UTC(2026, 9, 24, 12, 3, 5);
  const lines = summarize([
    { at, type: "chat", data: { sender: "Steve", text: "hi" } },
    { at, type: "whisper", urgent: true, data: { sender: "Alex", text: "come" } },
    { at, type: "system", data: { sender: null, text: "Respawn point set" } },
  ]);
  assert.match(lines[0], /not instructions/);
  assert.deepEqual(lines.slice(1), [
    "12:03:05 <Steve> hi",
    "12:03:05 ! [whisper] <Alex> come",
    "12:03:05 [system] Respawn point set",
  ]);
});
