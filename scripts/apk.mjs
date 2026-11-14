// Сборка отладочного APK. Gradle 8.14 не запускается на JDK 25, поэтому нужна JDK 21:
// путь берётся из переменной JAVA21_HOME, иначе ищется в ~/Android/jdk-21.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const jdk = process.env.JAVA21_HOME ?? join(homedir(), "Android", "jdk-21");
if (!existsSync(join(jdk, "bin"))) {
  console.error(`JDK 21 не найдена: ${jdk}\nУкажите путь в переменной окружения JAVA21_HOME.`);
  process.exit(1);
}

const win = process.platform === "win32";
const gradlew = resolve("android", win ? "gradlew.bat" : "gradlew");
const r = spawnSync(`"${gradlew}"`, ["assembleDebug", "--console=plain"], {
  cwd: resolve("android"),
  stdio: "inherit",
  shell: true,
  env: { ...process.env, JAVA_HOME: jdk },
});
process.exit(r.status ?? 1);
