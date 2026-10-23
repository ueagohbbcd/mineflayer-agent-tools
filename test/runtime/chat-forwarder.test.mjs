import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Inbox, localInboxClient } from "../../runtime/inbox/index.mjs";
import { startChatForwarder } from "../../runtime/default-scripts/chat.mjs";

function nativeBot(username = "arena_red1") {
  return Object.assign(new EventEmitter(), { username });
}

function setup(options = {}) {
  const inbox = new Inbox({ sessionId: "chat" });
  const bot = nativeBot(options.username);
  const chat = startChatForwarder({ bot, inbox: localInboxClient(inbox), ...options });
  const report = () => inbox.items.map((item) => item.message);
  return { inbox, bot, chat, report };
}

test("chat and whispers share one untrusted report until it is read", async () => {
  const { inbox, bot, chat, report } = setup();
  bot.emit("chat", "player", "same");
  bot.emit("chat", "player", "same");
  bot.emit("whisper", "player", "secret");
  await chat.flush();

  assert.equal(report().length, 1);
  const [message] = report();
  assert.equal(message.kind, "state");
  assert.equal(message.key, "game.chat");
  assert.equal(message.data.type, "game.chat");
  assert.equal(message.data.source, "minecraft");
  assert.equal(message.data.trusted, false);
  assert.deepEqual(
    message.data.lines.map((line) => [line.channel, line.sender, line.text]),
    [
      ["chat", "player", "same"],
      ["chat", "player", "same"],
      ["whisper", "player", "secret"],
    ],
  );
  assert.equal(typeof message.data.lines[0].observedAt, "number");

  // After the model read it, the next line starts a new report.
  inbox.drain();
  bot.emit("chat", "player", "later");
  await new Promise((done) => setTimeout(done, 20));
  await chat.flush();
  assert.deepEqual(report()[0].data.lines.map((line) => line.text), ["later"]);

  await chat.close();
  bot.emit("chat", "player", "after close");
  assert.equal(bot.listenerCount("chat"), 0);
  assert.equal(bot.listenerCount("whisper"), 0);
});

test("mention wake rules: names, whispers, own lines and regex characters", async () => {
  const { bot, chat, report } = setup({ username: "arena.red", wake: "mention" });
  // Mineflayer passes the sender and the body without the "<name>" prefix.
  bot.emit("chat", "player", "hello arenaXred");
  await chat.flush();
  assert.equal(report()[0].priority, "normal");
  bot.emit("chat", "player", "hello arena.red!");
  bot.emit("whisper", "player", "private message");
  bot.emit("chat", "arena.red", "arena.red says hello");
  bot.emit("whisper", "arena.red", "to myself");
  await chat.flush();
  assert.equal(report().length, 1);
  assert.equal(report()[0].priority, "urgent");
  assert.deepEqual(
    report()[0].data.lines.map((line) => [line.channel, line.text]),
    [
      ["chat", "hello arenaXred"],
      ["chat", "hello arena.red!"],
      ["whisper", "private message"],
    ],
  );
  await chat.close();
});

test("system lines are forwarded without waking; action-bar lines are not", async () => {
  const { bot, chat, report } = setup({ username: "arena.red", wake: "all" });
  bot.emit("messagestr", "Respawn point set", "system");
  bot.emit("messagestr", "You may not rest now", "game_info");
  bot.emit("messagestr", "<player> hi", "chat");
  await chat.flush();
  assert.equal(report()[0].priority, "normal");
  assert.deepEqual(
    report()[0].data.lines.map((line) => [line.channel, line.text, line.sender]),
    [["system", "Respawn point set", null]],
  );
  await chat.close();
  assert.equal(bot.listenerCount("messagestr"), 0);
});

test("aborting the native chat subscription removes its Mineflayer listeners", async () => {
  const bot = nativeBot();
  const controller = new AbortController();
  const chat = startChatForwarder({
    bot,
    inbox: localInboxClient(new Inbox({ sessionId: "chat" })),
    signal: controller.signal,
  });
  assert.equal(bot.listenerCount("chat"), 1);
  assert.equal(bot.listenerCount("whisper"), 1);
  controller.abort();
  await chat.done;
  await chat.close();
  assert.equal(bot.listenerCount("chat"), 0);
  assert.equal(bot.listenerCount("whisper"), 0);
});
