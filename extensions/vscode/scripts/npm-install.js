/**
 * @file Install node modules for the VS Code extension and gui. This is also intended to run as a child process.
 */

const { fork } = require("child_process");
const path = require("path");

const { execCmdSync } = require("../../../scripts/util");

const { continueDir } = require("./utils");

function pnpmInstallWithFallback(label) {
  // Packaging should work in both online and offline environments.
  // Try an offline, lockfile-respecting install first; if it fails (e.g. cold store),
  // fall back to a normal install.
  try {
    execCmdSync("CI=true pnpm install --frozen-lockfile --offline");
    console.log(`[info] pnpm install (${label}) completed (offline)`);
    return;
  } catch (e) {
    console.warn(
      `[warn] pnpm install (${label}) offline failed; retrying online (this is expected on cold caches)`,
    );
  }
  execCmdSync("CI=true pnpm install");
  console.log(`[info] pnpm install (${label}) completed (online)`);
}

async function installNodeModulesInGui() {
  process.chdir(path.join(continueDir, "gui"));
  pnpmInstallWithFallback("gui");
}

async function installNodeModulesInVscode() {
  process.chdir(path.join(continueDir, "extensions", "vscode"));
  pnpmInstallWithFallback("extensions/vscode");
}

process.on("message", (msg) => {
  const { targetDir } = msg.payload;
  if (targetDir === "gui") {
    installNodeModulesInGui()
      .then(() => process.send({ done: true }))
      .catch((error) => {
        console.error(error); // show the error in the parent process
        process.send({ error: true });
      });
  } else if (targetDir === "vscode") {
    installNodeModulesInVscode()
      .then(() => process.send({ done: true }))
      .catch((error) => {
        console.error(error); // show the error in the parent process
        process.send({ error: true });
      });
  }
});

async function npmInstall() {
  const installVscodeChild = fork(__filename, {
    stdio: "inherit",
  });
  installVscodeChild.send({ payload: { targetDir: "vscode" } });

  const installGuiChild = fork(__filename, {
    stdio: "inherit",
  });
  installGuiChild.send({ payload: { targetDir: "gui" } });

  await Promise.all([
    new Promise((resolve, reject) => {
      installVscodeChild.on("message", (msg) => {
        if (msg.error) {
          reject();
        }
        resolve();
      });
    }),
    new Promise((resolve, reject) => {
      installGuiChild.on("message", (msg) => {
        if (msg.error) {
          reject();
        }
        resolve();
      });
    }),
  ]).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  npmInstall,
};
