/** Write one rendered log view completely before committing its read position. */
export async function writeLogResult(result, output = process.stdout) {
  await new Promise((resolve, reject) => {
    output.write(result.text, (error) => (error ? reject(error) : resolve()));
  });
  await result.commit();
}
