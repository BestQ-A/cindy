/**
 * OS, storage and protocol identity for the independent Cindy Privacy fork.
 * Forge, desktop runtime and script mirrors must use these same values.
 * Official Cindy profiles and URL registrations are intentionally separate.
 * The region remains a build-time choice with Global as its default.
 */

/**
 * 构建期区域维度(与 mobile 的 EXPO_PUBLIC_CINDY_AUTH_REGION 同语义)。
 * 2026-07-20 新增第三目标 `dev`:独立系统身份(CindyDev,可与 cn/global 同机
 * 三装),连接独立的 dev 服务器(config/endpoint.dev.json,服务端就绪前为
 * 约定占位域名)。行为语义上 dev 归 cn 系(登录线/文案等运行时按区域分支处
 * 与 cn 同待遇),差异只在端点与身份。注意与「开发模式(未注入区域的本地
 * dev 构建)」区分:那仍默认 global 身份。
 */
export type CindyRegion = 'cn' | 'global' | 'dev';

/** 默认区域:Global。开发模式 / 未显式注入区域的构建一律落在这里。 */
export const DEFAULT_CINDY_REGION: CindyRegion = 'global';

/**
 * 归一化区域输入(构建脚本 env / 运行时注入值)。空值 → 默认 global;
 * 非法值抛错——打包链路宁可失败也不能默默打出身份错误的包。
 */
export function resolveCindyRegion(raw?: string | null): CindyRegion {
  const v = raw?.trim().toLowerCase();
  if (!v) return DEFAULT_CINDY_REGION;
  if (v === 'cn' || v === 'global' || v === 'dev') return v;
  throw new Error(`Invalid Cindy region: ${raw}; expected cn, global or dev`);
}

/** 标识符层身份配置的完整形状。字段语义见各注释;全部为纯数据,零运行时逻辑。 */
export interface BrandIdentity {
  /** 展示名(与 branding.ts 的 BRAND_NAME 同源,这里仅聚合成完整档案)。 */
  readonly displayName: string;
  /**
   * 可执行文件基名(Windows 加 .exe;mac Mach-O 名同源派生)。
   * 首字母大写是产品决策(Cindy.exe,同 Discord/Slack 惯例);Windows 进程
   * 匹配大小写不敏感,产物 / OSS key 命名走小写的 `cdnPrefix`,互不影响。
   * ⚠️ 这是 **cn / dev 基线值**;2026-07-18 支持同机双装后,打包与运行时
   * 一律走 `brandExecutableName(region)` 取区域值,本字段仅供 dev 链路
   * (restart 脚本镜像)与 legacy 消费点使用。
   */
  readonly executableName: string;
  /**
   * 按区域派生的可执行文件基名(exe / mac .app 包名 / 安装目录 / NSIS
   * 快捷方式全部跟随)。2026-07-26 owner 决策:cn 与 global 同值 'Cindy',
   * 让 global 包在 Dock / Finder / 菜单栏 / Windows 快捷方式等全部位置显示
   * Cindy——代价是 cn/global 同机双装时安装目录 / .app / .lnk 同名互抢
   * (第二个安装覆盖第一个的文件与快捷方式,更新器按 exe 名杀进程会波及另一
   * 区域),该场景明确放弃支持;appId 与 userData 目录仍按区域分离,系统身份
   * 与数据互不影响。dev 保持独立名(CindyDev,可与正式包并存)。区域名不含
   * 空格(部分系统对带空格路径的兼容性差,owner 决策)。
   */
  readonly executableNameByRegion: Readonly<Record<CindyRegion, string>>;
  /**
   * Windows AppUserModelId = NSIS appId = macOS bundle id,按区域派生
   * (cn/global 是两个可并存的系统身份,与 mobile 同一套命名)。
   * ⚠️ AUMID 三位一体:NSIS appId、运行时 setAppUserModelId、快捷方式 AUMID
   * 必须逐字符一致,否则 Windows toast 通知被静默丢弃。取值经 `brandAppId()`。
   */
  readonly appIdByRegion: Readonly<Record<CindyRegion, string>>;
  /** 深链主 scheme(OS 级注册,`<scheme>://session/...`;cn/global 不区分)。 */
  readonly primaryScheme: string;
  /** 历史 scheme,永久保持注册 + 解析兼容(存量链接不能死)。只增不减。 */
  readonly legacySchemes: readonly string[];
  /**
   * Electron 默认派生的 userData 目录名(= package.json productName)。已发布的
   * cn 构建沿用该目录；global 继续使用历史独立目录 `CindyGlobal`，避免启动时
   * 改名或搬迁用户数据。
   */
  readonly userDataDirName: string;
  /** 按区域派生的 userData 目录名。 */
  readonly userDataDirNameByRegion: Readonly<Record<CindyRegion, string>>;
  /** 品牌翻转前的共享历史 userData 目录名(首登 mToc 迁移使用)。只增不减。 */
  readonly legacyUserDataDirNames: readonly string[];
  /**
   * 各区域曾经使用过的 userData 目录名。按路径识别进程的消费点只能匹配本区域，
   * 不能把另一发行版的历史目录纳入自己的 kill / 回收范围。只增不减。
   */
  readonly legacyUserDataDirNamesByRegion: Readonly<
    Record<CindyRegion, readonly string[]>
  >;
  /**
   * 各区域的 sessions.working_dir 迁移来源。它与进程路径归属清单故意分离。
   */
  readonly legacyDialogueUserDataDirNamesByRegion: Readonly<
    Record<CindyRegion, readonly string[]>
  >;
  /**
   * 更新分发 CDN / OSS 的一级路径前缀(渠道身份,老客户端永远只看自己的前缀)。
   * ⚠️ 两区共用(owner 决策 2026-07-18):cn / global 的发布渠道靠**不同
   * OSS bucket** 区分,不靠路径前缀——本字段不做区域派生,发布侧矩阵按
   * region 选 bucket。
   */
  readonly cdnPrefix: string;
  /** 更新器/迁移执行器产物基名(`<updaterName>.exe`)。 */
  readonly updaterName: string;
  /** 本地主库文件名前缀(`<dbFilePrefix>-<userId>.db`)。 */
  readonly dbFilePrefix: string;
  /** 历史主库文件名前缀；首登本地迁移扫描旧库时只增不减。 */
  readonly legacyDbFilePrefixes: readonly string[];
}

/** Privacy installations use independent paths, app IDs and protocol registration. */
export const BRAND_IDENTITY: BrandIdentity = Object.freeze({
  displayName: 'Cindy Privacy',
  executableName: 'CindyPrivacyCN',
  executableNameByRegion: Object.freeze({
    cn: 'CindyPrivacyCN',
    global: 'CindyPrivacy',
    dev: 'CindyPrivacyDev',
  }),
  appIdByRegion: Object.freeze({
    cn: 'com.bestqa.cindyprivacycn',
    global: 'com.bestqa.cindyprivacy',
    dev: 'com.bestqa.cindyprivacydev',
  }),
  primaryScheme: 'cindy-privacy',
  legacySchemes: Object.freeze([]),
  userDataDirName: 'CindyPrivacyCN',
  userDataDirNameByRegion: Object.freeze({
    cn: 'CindyPrivacyCN',
    global: 'CindyPrivacy',
    dev: 'CindyPrivacyDev',
  }),
  legacyUserDataDirNames: Object.freeze([]),
  legacyUserDataDirNamesByRegion: Object.freeze({
    cn: Object.freeze([]),
    global: Object.freeze([]),
    dev: Object.freeze([]),
  }),
  legacyDialogueUserDataDirNamesByRegion: Object.freeze({
    cn: Object.freeze([]),
    global: Object.freeze([]),
    dev: Object.freeze([]),
  }),
  cdnPrefix: 'cindy-privacy',
  updaterName: 'cindy-privacy-updater',
  dbFilePrefix: 'cindy',
  legacyDbFilePrefixes: Object.freeze(['xdt-maker']),
});

/** 按区域取 appId(AUMID / bundle id);默认 global。 */
export function brandAppId(
  region: CindyRegion = DEFAULT_CINDY_REGION,
  identity: BrandIdentity = BRAND_IDENTITY,
): string {
  return identity.appIdByRegion[region];
}

/** 自有 UTI / ProgId 等派生标识的前缀(如 `<prefix>.cindy` UTI),随区域 appId 走。 */
export function brandBundleIdPrefix(
  region: CindyRegion = DEFAULT_CINDY_REGION,
  identity: BrandIdentity = BRAND_IDENTITY,
): string {
  return identity.appIdByRegion[region];
}

/** 按区域取可执行文件基名(exe / mac .app / 安装目录 / 快捷方式名);默认 global。 */
export function brandExecutableName(
  region: CindyRegion = DEFAULT_CINDY_REGION,
  identity: BrandIdentity = BRAND_IDENTITY,
): string {
  return identity.executableNameByRegion[region];
}

/** 按区域取 Electron userData 目录名;默认 global。 */
export function brandUserDataDirName(
  region: CindyRegion = DEFAULT_CINDY_REGION,
  identity: BrandIdentity = BRAND_IDENTITY,
): string {
  return identity.userDataDirNameByRegion[region];
}

/** 深链需要注册/解析的全部 scheme(主 + 历史),顺序稳定:主 scheme 恒为首位。 */
export function allDeepLinkSchemes(identity: BrandIdentity = BRAND_IDENTITY): readonly string[] {
  return [identity.primaryScheme, ...identity.legacySchemes];
}

/**
 * 按路径识别本产品 userData 的全部目录名(本区域当前 + 本区域明确拥有的历史名)，
 * 本区域目录名恒为首位。⚠️ 故意**不包含另一区域当前或历史使用的目录**：同机双装
 * 时 orphan-reaper 等按路径匹配的消费点只应认领自己区域的进程，跨区域匹配会误杀。
 */
export function allUserDataDirNames(
  region: CindyRegion = DEFAULT_CINDY_REGION,
  identity: BrandIdentity = BRAND_IDENTITY,
): readonly string[] {
  return [
    identity.userDataDirNameByRegion[region],
    ...identity.legacyUserDataDirNamesByRegion[region],
  ];
}

/**
 * 按区域取持久化 dialogue cwd 的历史 userData 目录名。只用于数据迁移，
 * 绝不能用于判断进程归属或清理另一实例。
 */
export function legacyDialogueUserDataDirNames(
  region: CindyRegion = DEFAULT_CINDY_REGION,
  identity: BrandIdentity = BRAND_IDENTITY,
): readonly string[] {
  return identity.legacyDialogueUserDataDirNamesByRegion[region];
}

/** 品牌翻转前的共享老目录候选，仅供 cn 的 mToc 首登数据导入。 */
export function legacyBrandUserDataDirNames(
  identity: BrandIdentity = BRAND_IDENTITY,
): readonly string[] {
  return identity.legacyUserDataDirNames;
}
