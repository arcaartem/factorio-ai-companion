// Test the /companion_help command
import { RCONClient } from "./rcon/client";
import { asArray } from "./utils/connection";

const rcon = new RCONClient({
  host: process.env.FACTORIO_HOST || "127.0.0.1",
  port: parseInt(process.env.FACTORIO_RCON_PORT || "34198"),
  password: process.env.FACTORIO_RCON_PASSWORD || "factorio",
});

async function main() {
  try {
    await rcon.connect();
    console.log("Connected to RCON");

    const response = await rcon.sendCommand("/fac_help");

    console.log("Raw response:", response);

    if (response.success && response.data) {
      try {
        const help = JSON.parse(response.data);
        console.log("\n=== Companion Commands (v" + help.version + ") ===\n");

        const commands = asArray<{name: string, params: string, description: string, examples: string[]}>(help.commands);
        commands.forEach((cmd, i: number) => {
          console.log(`${i + 1}. ${cmd.name} ${cmd.params}`);
          console.log(`   ${cmd.description}`);
          console.log(`   Examples: ${asArray<string>(cmd.examples).join(", ")}`);
          console.log();
        });

        console.log("Notes:");
        asArray<string>(help.notes).forEach((note) => console.log(`- ${note}`));
      } catch (e) {
        console.error("JSON parse error. Response data:", response.data);
      }
    } else {
      console.error("Failed to get help:", response);
    }

    await rcon.disconnect();
  } catch (e) {
    console.error("Error:", e);
    process.exit(1);
  }
}

main();
