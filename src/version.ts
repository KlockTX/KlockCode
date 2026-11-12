/**
 * 对外报出的版本号，唯一真源。
 *
 * 发版前这里有过四处各自硬编码的 "1.2.1"：健康接口 / SSE 握手 / MCP client /
 * web-fetch 的 User-Agent，打包脚本里还有第五处兜底。只改 package.json 的结果是
 * 打好的安装包继续对外报旧版本，release-smoke 在 afterPack 直接挂掉，而且这种
 * 不一致会一路带进线上（更新检查看到的还是旧号）。
 *
 * 现在所有消费方都 import 这个常量；version.test.ts 把它与根 package.json 和
 * desktop/package.json 钉在一起 —— 下次漏改会在测试里失败，而不是在发版末尾。
 */
export const APP_VERSION = "1.3.2";
