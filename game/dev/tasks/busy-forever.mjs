// Never returns to the event loop; only `stop` (SIGKILL) gets out of this.
export default async function task () {
  for (;;) {}
}
