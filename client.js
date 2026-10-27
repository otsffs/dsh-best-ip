window.__ModuleLoader__.load({
  id: 'dsh-best-ip',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const NS = 'dsh-best-ip'
    const BASE = '/api/dsh-best-ip'

    const en = {
      meta: {
        title: 'Model Node Optimizer',
        description:
          'Benchmark the current default model API and pick the fastest, most stable resolved IP node, optionally applying it.',
      },
      section: 'Model Node Optimizer',
      title: 'Model Node Optimizer',
      subtitle: 'Benchmark the current default model API and pick the fastest, most stable resolved IP node, optionally applying it.',
      enabled: 'Enabled',
      enabledHint: 'When off, every request uses the system resolver again.',
      defaultModel: 'Default model',
      noDefault: 'DSH has no default model selected yet.',
      benchmarkUnavailable: 'Speed testing is unavailable: {reason}',
      benchmarkReasons: { OAUTH_UNSUPPORTED: 'OAuth providers are not supported yet; choose a default provider using an API key', UNSUPPORTED_ADAPTER: 'this model adapter is not supported', UNRESOLVED_ENDPOINT: 'the default model endpoint/protocol could not be resolved', UNSUPPORTED_PROTOCOL: 'only Chat Completions, Responses and Anthropic Messages are supported', HTTPS_REQUIRED: 'an HTTPS endpoint is required', DYNAMIC_ENDPOINT: 'native authentication may replace the configured endpoint', NO_DEFAULT_MODEL: 'select a DSH default model first', NO_DEFAULT_PROVIDER: 'select a DSH default provider first', UNRESOLVED_AUTH: 'the native authentication mode cannot be safely used as an API key', MISSING_CREDENTIAL: 'configure an API key for the default provider', UNKNOWN_MODEL: 'the selected default model is no longer available in this provider', NO_ACTIVE_PROVIDER: 'the default provider is not registered/enabled', PROVIDER_ERROR: 'the default provider configuration has an error' },
      autoTest: 'Auto speed test',
      autoTestAndApply: 'Auto speed test and apply',
      testing: 'Testing…',
      testingAndApply: 'Testing and applying…',
      autoTestTitle: 'Test and recommend only; keep the current address unchanged.',
      autoApplyTitle: 'Apply the recommended address after successful testing. Keep the current address on failure.',
      speedTest: 'Automatic speed test',
      speedTestHint:
        'Discover addresses, reserve one slot for the previously selected IP, then fill the remaining slots by lowest ping (all by default) over 3 rounds by default. Rank by capped harmonic speed, lower-quartile speed, actual success rate and measurement confidence; skipped requests do not count as failures.',
      maxBenchmarkIps: 'Maximum test IPs',
      benchmarkIpLimitAll: 'All',
      benchmarkIpLimitCustom: 'Custom',
      benchmarkIpLimitCount: '{count} IPs',
      benchmarkIpLimitHint: 'Only limits speed tests, not discovery. The current choice applies to both buttons; save to remember it.',
      benchmarkIpLimitInvalid: 'Enter a positive whole number of IPs.',
      benchmarkCostAllSummary: 'All: up to about {compactTotalEn} tokens',
      benchmarkCostLimitSummary: '{count} IPs: up to about {compactTotalEn} tokens',
      benchmarkCostDetails: 'Token budget details',
      benchmarkCostHint: 'Budget for {count} usable IPs × {runs} runs/IP × up to {tokens} output tokens/run: about {total} output tokens, plus input tokens. Actual usage depends on usable IPs and output length.',
      benchmarkCostAllHint: '“All” is estimated using the extra scan budget of {count} IPs. DNS answers and a previously selected IP are additional to the scan budget, so the actual IP count may be higher.',
      stepProbe: 'Discovering addresses',
      stepBenchmark: 'Timing throughput',
      stepConfirm: 'Repeating measurements',
      stepDone: 'Done',
      stepFailed: 'Failed',
      probed: 'tried',
      usable: 'usable',
      resolversDone: 'resolvers answered',
      timeNow: 'Test this address',
      timingNow: 'Testing…',
      timeNowResult: 'Current address',
      testingAddress: 'Testing',
      runs: 'runs',
      run: 'run',
      current: 'Current IP',
      range: 'Spread',
      addresses: 'Measured IP nodes',
      ipAndEdge: 'IP / Edge',
      medianTps: 'Median TPS',
      samplesLabel: 'Each run',
      timing: 'Latency',
      action: 'Action',
      applyRecommended: 'Apply recommended IP',
      noAddresses: 'Nothing measured yet. Press “Auto speed test”.',
      noValidIp: 'No valid IP address.',
      ping: 'Ping',
      ttft: 'First token',
      tps: 'Median TPS (each run)',
      tokens: 'Tokens',
      edge: 'Edge',
      inUse: 'In use',
      use: 'Apply this address',
      untested: 'not timed',
      unusable: 'unusable',
      applies: 'Applied: best speed-and-stability score in this run.',
      actionsHint: '“Auto speed test” only recommends; “Auto speed test and apply” also changes the selected IP after success. Both cost API tokens.',
      previewDone: 'Test complete. Recommendation: {ip}. Current address unchanged.',
      defaultChangedHint: 'The DSH default provider/model changed. Samples were saved, but no address was applied.',
      recommended: 'Recommended',
      systemDns: 'System DNS',
      resultHint: 'V2 scores rank first; provisional scores need at least 2 reliable samples for recommendation. ⚠ retains raw TPS: high values may be capped, not failed. Skipped nodes are eliminated; legacy records need a retest.',
      score: 'Composite score',
      scoreHint: '100 × (80% capped harmonic TPS + 20% capped Q25) / median node harmonic TPS × actual success rate² × measurement confidence. Confidence = reliable/successful requests × min(1, reliable runs/2). Unstarted, skipped and cancelled requests are not failures.',
      provisional: 'Provisional',
      confirmed: 'Confirmed',
      eliminated: 'Eliminated / skipped',
      legacyRecord: 'Legacy record; retest required',
      incompleteRetest: 'Incomplete retest; this result is not confirmed.',
      appliedIncompleteHint: 'Address applied manually before the full retest completed; this result is not confirmed.',
      appliedLegacyHint: 'Address applied manually from a legacy record; retest with scoring v2 before relying on it.',
      noRecommendationHint: 'Test complete. Not enough reliable evidence for a recommendation; current address unchanged.',
      measured: 'tested',
      skipped: 'skipped',
      budget: 'planned',
      round: 'Round',
      leading: 'Provisional leader',
      successfulSamples: 'successful',
      failedSamples: 'failed',
      measurementConfidence: 'Measurement confidence',
      scoreUncalibrated: 'Provisional calibration',
      scoreReference: 'Shared speed reference',
      scoreCap: 'Shared speed cap',
      scoreUncapped: 'not capped',
      scoredTps: 'TPS used for scoring',
      timeoutBudget: 'timeout budget',
      stop: 'Stop test',
      stopping: 'Stopping…',
      stopped: 'Stopped',
      stoppedHint: 'Stopped. Completed samples were saved; the current address was not changed.',
      stoppingHint: 'Cancelling active requests and saving completed samples…',
      sampleMissing: 'not tested',
      sampleSkipped: 'skipped',
      sampleStopped: 'stopped',
      sampleFailed: 'failed',
      sampleUnmeasurable: 'unmeasurable',
      sampleLegacy: 'individual samples unavailable; retest',
      samplesInsufficient: 'insufficient reliable samples',
      reliableSamples: 'reliable',
      sampleReasons: { 'transport-error': 'request failed', cancelled: 'cancelled', unmeasurable: 'invalid usage/timing', 'insufficient-tokens': 'fewer than 32 output tokens', 'missing-decode-window': 'missing decode duration', 'invalid-decode-window': 'invalid decode duration', 'insufficient-decode-window': 'decode window below 200 ms', 'high-outlier': 'legacy high-outlier flag; retest with scoring v2', 'high-capped': 'raw high TPS retained; only its scoring value is capped, not a request failure', 'low-tail': 'slow sample retained in scoring' },
      forget: 'Clear and restore system DNS',
      probedAgo: 'measured {age} ago',
      never: 'never',
      seconds: 's',
      minutes: 'min',
      hours: 'h',
      message: 'Test message',
      messageHint:
        'Longer output measures throughput more reliably. A greeting produces too few tokens to time.',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      saved: 'Saved.',
      saveFailed: 'Save failed',
      loadFailed: 'Could not read plugin state',
      advanced: 'Advanced',
      servers: 'DNS servers',
      serversHint:
        'Only used to discover candidate addresses during an automatic speed test. Requests never resolve through them afterwards — they go to the measured address.',
      scanEdges: 'Also scan Cloudflare edge ranges',
      scanEdgesHint:
        'Without this only the addresses DNS returns are tested, and they usually all land in the same far datacenter.',
      subdomains: 'Include subdomains',
      fallback: 'Fall back to system DNS',
      fallbackHint: 'When the pinned servers fail, retry with the system resolver instead of failing the request.',
      why: 'Why an address has to be chosen',
      whyBody:
        'Every resolver returns the same Cloudflare addresses for a proxied host, and which datacenter answers depends on this network’s route — not on the resolver. A different Cloudflare address can move the request, so addresses are measured rather than resolved. Ping alone is not enough either: the nearest edge is often not the fastest stream.',
      stats: 'Activity',
      statPinned: 'Pinned queries',
      statCache: 'Cache hits',
      statFailures: 'Failures',
      statFallbacks: 'Fallbacks',
      storage: 'Stored at',
      addServer: 'Add a DNS server',
      presets: 'Common resolvers',
      badServer: 'Enter an IPv4 or IPv6 address.',
      lastAnswers: 'What each resolver returned',
      resolverRole:
        'The system resolver is queried too, so its answer — what this machine would use without the plugin — is compared against every alternative.',
    }

    const zh = {
      meta: {
        title: '模型节点优选',
        description: '为当前默认模型实测 API 速度，自动选出最快且最稳定的解析 IP 节点，并按需应用。',
      },
      section: '模型节点优选',
      title: '模型节点优选',
      subtitle: '为当前默认模型实测 API 速度，自动选出最快且最稳定的解析 IP 节点，并按需应用。',
      enabled: '启用',
      enabledHint: '关闭后所有请求重新使用系统解析器。',
      defaultModel: '默认模型',
      noDefault: 'DSH 还没有选择默认模型。',
      benchmarkUnavailable: '暂不能测速：{reason}',
      benchmarkReasons: { OAUTH_UNSUPPORTED: '暂不支持 OAuth 供应商，请选择使用 API Key 的默认供应商', UNSUPPORTED_ADAPTER: '暂不支持此模型适配器', UNRESOLVED_ENDPOINT: '无法确定默认模型的 API 地址或协议', UNSUPPORTED_PROTOCOL: '仅支持 Chat Completions、Responses 和 Anthropic Messages', HTTPS_REQUIRED: '需要 HTTPS API 地址', DYNAMIC_ENDPOINT: '原生身份验证可能动态改变 API 地址', NO_DEFAULT_MODEL: '请先选择 DSH 默认模型', NO_DEFAULT_PROVIDER: '请先选择 DSH 默认供应商', UNRESOLVED_AUTH: '无法安全地将当前原生身份验证用于 API Key 测速', MISSING_CREDENTIAL: '请为默认供应商配置 API Key', UNKNOWN_MODEL: '所选默认模型已不在该供应商的模型列表中', NO_ACTIVE_PROVIDER: '默认供应商尚未启用或注册', PROVIDER_ERROR: '默认供应商配置存在错误' },
      autoTest: '自动测速',
      autoTestAndApply: '自动测速并应用',
      testing: '测速中…',
      testingAndApply: '测速并应用中…',
      autoTestTitle: '仅测速并推荐，不改变当前地址。',
      autoApplyTitle: '测速成功后应用推荐地址；失败保留当前地址。',
      speedTest: '自动测速',
      speedTestHint:
        '先发现地址，优先为上次已选 IP 保留一个测速名额，其余按 ping 从低到高选取（默认全部），按轮次测速（默认 3 轮）；综合封顶调和速度、低四分位速度、实际成功率和测量可信度评分，跳过的请求不算失败。',
      maxBenchmarkIps: '最大测速 IP 数',
      benchmarkIpLimitAll: '全部',
      benchmarkIpLimitCustom: '任意（自定义）',
      benchmarkIpLimitCount: '{count} 个',
      benchmarkIpLimitHint: '只限制测速，不减少地址探测。两个按钮均使用当前选择；保存后记住此设置。',
      benchmarkIpLimitInvalid: '请输入正整数 IP 数量。',
      benchmarkCostAllSummary: '全部最多约{compactTotal} token',
      benchmarkCostLimitSummary: '{count} 个最多约{compactTotal} token',
      benchmarkCostDetails: 'Token 预算详情',
      benchmarkCostHint: '按 {count} 个有效 IP × 每 IP {runs} 次 × 每次最多 {tokens} 输出 token 估算：约 {total} 输出 token 预算，另计输入 token。实际消耗取决于有效 IP 数和输出长度。',
      benchmarkCostAllHint: '“全部”以额外扫描上限 {count} 个 IP 为例；DNS 返回地址和上次已选 IP 不计入扫描上限，实际 IP 数可能更多。',
      stepProbe: '正在发现可用地址',
      stepBenchmark: '正在测速',
      stepConfirm: '正在多轮复测',
      stepDone: '完成',
      stepFailed: '失败',
      probed: '已探测',
      usable: '有效',
      resolversDone: '解析器已返回',
      timeNow: '测一下当前地址',
      timingNow: '测速中…',
      timeNowResult: '当前地址',
      testingAddress: '正在测试',
      runs: '次',
      run: '第',
      current: '当前 IP',
      range: '波动范围',
      addresses: '实测 IP 节点',
      ipAndEdge: 'IP / 机房',
      medianTps: 'TPS 中位数',
      samplesLabel: '逐次 TPS',
      timing: '延迟',
      action: '操作',
      applyRecommended: '应用推荐地址',
      noAddresses: '还没有测量结果。点“自动测速”。',
      noValidIp: '无有效IP地址',
      ping: '延迟',
      ttft: '首次 token',
      tps: 'TPS 中位数（每次）',
      tokens: 'token 数',
      edge: '机房',
      inUse: '使用中',
      use: '应用此地址',
      untested: '未测速',
      unusable: '不可用',
      applies: '已应用：本轮速度与稳定性综合得分最优的地址。',
      actionsHint: '“自动测速”仅推荐，不改变当前地址；“自动测速并应用”会在成功后应用推荐地址。两者都会消耗 API token。',
      previewDone: '测试完成，推荐 {ip}；当前地址未改变。',
      defaultChangedHint: 'DSH 默认供应商或模型已改变，已保留测试样本，但未应用地址。',
      recommended: '推荐地址',
      systemDns: '系统 DNS',
      resultHint: '优先按 v2 综合分排名；暂列分需至少 2 次可信样本才可推荐。⚠ 保留原始 TPS，高值仅封顶而非失败；跳过节点视为淘汰，旧记录需重测。',
      score: '综合得分',
      scoreHint: '得分 = 100 ×（80% 封顶调和 TPS + 20% 封顶 Q25）÷ 各节点调和 TPS 中位数 × 实际成功率² × 测量可信度。可信度 = 可信样本/成功请求 × min(1, 可信样本数/2)。未测、跳过、取消均不是失败。',
      provisional: '暂列',
      confirmed: '已确认',
      eliminated: '淘汰 / 已跳过',
      legacyRecord: '旧记录，需重测',
      incompleteRetest: '未完整复测，此结果尚未确认。',
      appliedIncompleteHint: '已手动应用尚未完整复测的地址；此结果尚未确认。',
      appliedLegacyHint: '已手动应用旧记录地址，请使用 v2 评分重新测速后再作判断。',
      noRecommendationHint: '测试完成，可信证据不足以推荐；当前地址未改变。',
      measured: '已测',
      skipped: '跳过',
      budget: '计划',
      round: '轮次',
      leading: '可信暂列',
      successfulSamples: '成功',
      failedSamples: '失败',
      measurementConfidence: '测量可信度',
      scoreUncalibrated: '暂未完成校准',
      scoreReference: '全场共同速度基准',
      scoreCap: '全场共同速度上限',
      scoreUncapped: '未封顶',
      scoredTps: '评分使用 TPS',
      timeoutBudget: '超时预算',
      stop: '停止测试',
      stopping: '正在停止…',
      stopped: '已停止',
      stoppedHint: '已停止，已完成的样本已保留；当前地址未改变。',
      stoppingHint: '正在取消在途请求，并保存已完成的样本…',
      sampleMissing: '未测',
      sampleSkipped: '跳过',
      sampleStopped: '停止',
      sampleFailed: '失败',
      sampleUnmeasurable: '不可测',
      sampleLegacy: '逐次值未记录，需重新测速',
      samplesInsufficient: '可靠样本不足',
      reliableSamples: '可靠',
      sampleReasons: { 'transport-error': '请求失败', cancelled: '已取消', unmeasurable: '用量或计时无效', 'insufficient-tokens': '输出不足 32 token', 'missing-decode-window': '缺少出词时长', 'invalid-decode-window': '出词时长无效', 'insufficient-decode-window': '出词计时不足 200 毫秒', 'high-outlier': '旧版高值异常标记，请使用 v2 重测', 'high-capped': '原始高 TPS 保留，仅评分值封顶，不是请求失败', 'low-tail': '低速样本，仍计入评分' },
      forget: '清除并恢复系统 DNS',
      probedAgo: '{age}前测量',
      never: '从未',
      seconds: '秒',
      minutes: '分钟',
      hours: '小时',
      message: '测试消息',
      messageHint: '输出越长，速度测得越准。只回一句问候的 token 太少，测不出速度。',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      saved: '已保存。',
      saveFailed: '保存失败',
      loadFailed: '无法读取插件状态',
      advanced: '高级设置',
      servers: 'DNS 服务器',
      serversHint: '只在自动测速时用来发现候选地址；平时请求不经过它们解析，而是直连实测选出的地址。',
      scanEdges: '同时扫描 Cloudflare 边缘网段',
      scanEdgesHint: '不开的话只测 DNS 返回的地址，而它们通常都落在同一个远端机房。',
      subdomains: '包含子域名',
      fallback: '失败时回退系统 DNS',
      fallbackHint: '指定服务器查询失败时，改用系统解析器重试，而不是让请求直接失败。',
      why: '为什么必须实测选地址',
      whyBody:
        '对走 Cloudflare 的域名，所有解析器返回的都是同一组地址，真正决定落到哪个机房的是本条线路的路由，而不是解析器。换一个 Cloudflare 地址才能改变落点，所以这里以实测为准。而且只看 ping 也不行：最近的机房往往不是出词最快的。',
      stats: '运行情况',
      statPinned: '指定解析次数',
      statCache: '缓存命中',
      statFailures: '失败',
      statFallbacks: '回退系统解析',
      storage: '保存位置',
      addServer: '添加 DNS 服务器',
      presets: '常见公共 DNS',
      badServer: '请填写 IPv4 或 IPv6 地址。',
      lastAnswers: '各解析器的返回结果',
      resolverRole: '系统解析器也一定会被查询，用来和其它候选做对比。',
    }

    async function call(path, payload) {
      const response = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      // A failed run may still carry the value (so the panel can show what was
      // measured before it failed); only a missing value is a hard error.
      if (body?.ok !== true) {
        if (body?.value === undefined) throw new Error(body?.message ?? 'request failed')
        return { ...body.value, failure: body.message ?? 'request failed' }
      }
      return body.value
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px 24px', width: '100%', maxWidth: 780, minWidth: 0, boxSizing: 'border-box' },
      card: {
        minWidth: 0,
        boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
      title: { fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', margin: 0 },
      subtitle: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: 0, lineHeight: 1.6 },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
      label: { fontSize: 13, color: 'var(--dsw-alias-label-primary)', fontWeight: 500 },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.55 },
      costInfo: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 16, height: 16, flex: '0 0 auto', padding: 0,
        border: '1px solid currentColor', borderRadius: '50%',
        background: 'transparent', color: 'inherit', fontFamily: 'inherit',
        fontSize: 11, fontWeight: 700, lineHeight: 1, cursor: 'help',
      },
      input: {
        flex: 1,
        minWidth: 0,
        height: 30,
        padding: '0 9px',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 7,
        outline: 'none',
        fontFamily: 'inherit',
      },
      btn: {
        height: 28,
        padding: '0 12px',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 7,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontFamily: 'inherit',
      },
      primary: {
        height: 32,
        padding: '0 18px',
        fontSize: 13,
        fontWeight: 500,
        color: '#fff',
        background: 'var(--dsw-alias-brand-primary)',
        border: '1px solid transparent',
        borderRadius: 8,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontFamily: 'inherit',
      },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 8px',
        fontSize: 12,
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-primary)',
      },
      chips: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
      table: { width: '100%', minWidth: 740, tableLayout: 'fixed', borderCollapse: 'separate', borderSpacing: 0, fontSize: 12 },
      runsTable: { width: '100%', minWidth: 0, tableLayout: 'fixed', borderCollapse: 'separate', borderSpacing: 0, fontSize: 12 },
      runsHead: { display: 'block', fontSize: 10, fontWeight: 400, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.35 },
      runsCell: { padding: '7px 4px', borderBottom: '1px solid var(--dsw-alias-border-l1)', verticalAlign: 'top', minWidth: 0, fontVariantNumeric: 'tabular-nums' },
      resultsSurface: { width: '100%', minWidth: 0, containerType: 'inline-size', containerName: 'dsh-best-ip-results' },
      resultViewport: { width: '100%', minWidth: 0, maxHeight: 'min(60vh, 560px)', overflow: 'auto', position: 'relative', isolation: 'isolate', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 9, boxSizing: 'border-box' },
      resultIdentity: { position: 'sticky', left: 0, zIndex: 2, background: 'var(--dsw-alias-bg-layer-1)', borderRight: '1px solid var(--dsw-alias-border-l1)' },
      resultAction: { position: 'sticky', right: 0, zIndex: 2, background: 'var(--dsw-alias-bg-layer-1)', borderLeft: '1px solid var(--dsw-alias-border-l2)', boxShadow: '-5px 0 8px -7px var(--dsw-alias-label-secondary)' },
      resultApply: { width: '100%', minHeight: 32, height: 'auto', padding: '6px 8px', whiteSpace: 'normal', overflowWrap: 'anywhere', boxSizing: 'border-box' },
      resultCards: { minWidth: 0, maxWidth: '100%', maxHeight: 'min(60vh, 560px)', overflowY: 'auto', overflowX: 'hidden', flexDirection: 'column', gap: 10 },
      resultCard: { minWidth: 0, padding: 12, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 9, background: 'var(--dsw-alias-bg-layer-1)', display: 'flex', flexDirection: 'column', gap: 10 },
      resultCardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, minWidth: 0 },
      resultCardMetrics: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 112px), 1fr))', gap: 10, minWidth: 0 },
      resultMetric: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      sampleBadges: { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5, minWidth: 0, maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' },
      sampleBadge: { display: 'inline-flex', gap: 3, alignItems: 'baseline', padding: '2px 5px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 5, background: 'var(--dsw-alias-bg-layer-2)', maxWidth: '100%', minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' },
      th: {
        position: 'sticky',
        top: 0,
        zIndex: 3,
        background: 'var(--dsw-alias-bg-layer-2)',
        textAlign: 'left',
        fontWeight: 500,
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
        padding: '6px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        whiteSpace: 'normal',
        overflowWrap: 'anywhere',
        verticalAlign: 'top',
      },
      td: {
        padding: '9px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-primary)',
        whiteSpace: 'normal',
        overflowWrap: 'anywhere',
        verticalAlign: 'top',
      },
      best: { color: 'var(--dsw-alias-state-success-primary)', fontWeight: 600 },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      err: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap' },
      ok: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' },
      stats: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 8 },
      stat: {
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 9,
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      },
      statValue: { fontSize: 17, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      statLabel: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      switch: (on) => ({
        position: 'relative',
        width: 38,
        height: 22,
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)',
        cursor: 'pointer',
        flex: '0 0 auto',
        transition: 'background 120ms ease',
        padding: 0,
      }),
      knob: (on) => ({
        position: 'absolute',
        top: 2,
        left: on ? 18 : 2,
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: on ? '#fff' : 'var(--dsw-alias-label-secondary)',
        transition: 'left 120ms ease',
      }),
      actions: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' },
      progress: {
        height: 3,
        borderRadius: 2,
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-2)',
        position: 'relative',
      },
      progressBar: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: '35%',
        background: 'var(--dsw-alias-brand-primary)',
        borderRadius: 2,
        animation: 'dsh-best-ip-slide 1.2s ease-in-out infinite',
      },
    }

    const RESULTS_LAYOUT = `
      .dsh-best-ip-results-cards { display: none; }
      .dsh-best-ip-result-apply:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      @container dsh-best-ip-results (max-width: 620px) {
        .dsh-best-ip-results-wide { display: none; }
        .dsh-best-ip-results-cards { display: flex; }
      }
    `

    function Toggle({ on, onChange, label, hint, disabled = false }) {
      return h(
        'div',
        { style: S.row },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 260px' } },
          h('div', { style: S.label }, label),
          hint ? h('div', { style: S.hint }, hint) : null,
        ),
        h(
          'button',
          {
            type: 'button',
            disabled,
            role: 'switch',
            'aria-checked': on ? 'true' : 'false',
            'aria-label': label,
            style: S.switch(on),
            onClick: () => onChange(!on),
          },
          h('span', { style: S.knob(on) }),
        ),
      )
    }

    function describeBenchmarkCost(state, limit, t) {
      const count = limit === 0 ? state.maxCandidates ?? 160 : limit
      const runs = state.benchmarkRuns ?? 3
      const tokens = state.benchmarkMaxTokens ?? 256
      const total = count * runs * tokens
      const values = {
        count, runs, tokens, total: total.toLocaleString('en-US'),
        compactTotal: total >= 10000 ? `${Math.round(total / 10000)}w` : total.toLocaleString('en-US'),
        compactTotalEn: total >= 10000 ? `${Math.round(total / 10000) * 10}k` : total.toLocaleString('en-US'),
      }
      const format = (key) => t(key).replace(/\{(count|runs|tokens|total|compactTotal|compactTotalEn)\}/g, (_, name) => values[name])
      return {
        summary: format(limit === 0 ? 'benchmarkCostAllSummary' : 'benchmarkCostLimitSummary'),
        details: format('benchmarkCostHint') + (limit === 0 ? ` ${format('benchmarkCostAllHint')}` : ''),
      }
    }

    /** Human-readable, specific progress line from the server's live snapshot. */
    function describeProgress(progress, t) {
      if (progress === null || progress === undefined) return t('stepProbe')
      const budget = `${progress.timing ?? 0} ${t('measured')} + ${progress.skipped ?? 0} ${t('skipped')} / ${progress.timingTotal ?? 0} ${t('budget')}`
      const round = progress.round > 0 && progress.rounds > 0 ? ` · ${t('round')} ${progress.round}/${progress.rounds}` : ''
      const leading = progress.leading ? ` · ${t('leading')}: ${progress.leading}` : ''
      const timing = ` · ${budget}${round}`
      switch (progress.stage) {
        case 'discover':
          return `${t('stepProbe')} · ${t('resolversDone')} ${progress.resolversDone ?? 0}/${progress.resolvers ?? 0}`
        case 'inspect':
        case 'scan':
          return `${t('stepProbe')} · ${progress.attempted ?? 0}/${progress.total ?? 0} ${t('probed')} · ${progress.usable ?? 0} ${t('usable')}`
        case 'timing':
          return `${t('stepBenchmark')}${timing}${leading}`
        case 'confirm':
          return `${t('stepConfirm')} · ${(progress.rows ?? []).length} ${t('addresses')}${timing}${leading}`
        case 'stopping':
          return `${t('stopping')}${progress.timingTotal !== undefined ? timing : ''}`
        case 'stopped':
          return `${t('stopped')}${progress.timingTotal !== undefined ? timing : ''}`
        case 'done':
          return `${t('stepDone')}${progress.timingTotal !== undefined ? timing : ''}`
        case 'failed':
          return progress.message ?? t('stepFailed')
        default:
          return t('stepProbe')
      }
    }

    /** Terminal errors belong to the settled run, not the next state refresh. */
    function describeRunError(outcome, t) {
      const failure = outcome?.stage === 'failed'
        ? outcome.reasonCode === 'NO_USABLE_IP' ? t('noValidIp') : outcome.message ?? t('stepFailed')
        : null
      return [failure, outcome?.saveError].filter(Boolean).join('\n') || null
    }

    /** Rows arrive in the server's round-end rank order; never reshuffle them mid-round. */
    function RunsTable({ progress, t }) {
      const rows = Array.isArray(progress?.rows) ? progress.rows : []
      if (rows.length === 0) return null
      const width = Math.max(1, progress.rounds ?? 0, ...rows.map((row) => Math.max(row.summary?.plannedRuns ?? 0, Array.isArray(row.runs) ? row.runs.length : 0)))
      const columns = Array.from({ length: width }, (_, index) => index)
      // Fixed columns squeezed the third round off the panel. Share the remaining
      // width between rounds so the default three fit without sideways scrolling.
      return h('div', { style: { width: '100%', minWidth: 0, overflowX: 'auto' } },
        h('table', { style: S.runsTable },
          h('colgroup', null,
            h('col', { style: { width: '38%' } }),
            h('col', { style: { width: '22%' } }),
            columns.map((index) => h('col', { key: index, style: { width: `${40 / width}%` } })),
          ),
          h('thead', null, h('tr', null,
            h('th', { scope: 'col', style: { ...S.th, padding: '6px 4px' } }, t('ipAndEdge')),
            h('th', { scope: 'col', style: { ...S.th, padding: '6px 4px' }, title: t('scoreHint') }, t('score')),
            columns.map((index) => h('th', { key: index, scope: 'col', style: { ...S.th, padding: '6px 4px', textAlign: 'right' } },
              h('span', { style: { fontWeight: 500 } }, `${t('run')}${index + 1}`),
            )),
          )),
          h('tbody', null, rows.map((row, index) => {
            // Old live snapshots can still display real attempts, but never gain a v2 score.
            const summary = { ...row.summary, samples: Array.isArray(row.summary?.samples) ? row.summary.samples : row.runs ?? [], plannedRuns: Math.max(width, row.summary?.plannedRuns ?? 0) }
            const values = sampleValues(summary, t).slice(1, -1).split(', ')
            const details = sampleDetails(summary, t).split('\n')
            return h('tr', { key: row.ip },
              h('td', { style: { ...S.runsCell, ...S.mono, overflowWrap: 'anywhere' } },
                h('div', null, `${row.rank ?? index + 1}. ${row.ip}`),
                row.colo ? h('div', { style: { ...S.muted, fontSize: 10 } }, row.colo) : null,
              ),
              h('td', { style: S.runsCell }, h(ResultScore, { bench: row.summary, t })),
              columns.map((column) => h('td', {
                key: column,
                title: details[column],
                style: { ...S.runsCell, ...S.mono, ...S.muted, padding: column === width - 1 ? '7px 0 7px 4px' : '7px 4px',
                  textAlign: 'right', whiteSpace: 'normal', overflowWrap: 'anywhere' },
              }, values[column] ?? t('sampleMissing'))),
            )
          })),
        ),
      )
    }

    /**
     * Numeric ascending order for dotted-quad addresses.
     *
     * Resolvers return the same set of addresses in arbitrary order, so listing
     * them as they arrived makes identical answers look different. Comparing
     * octet by octet puts 104.21.45.58 before 172.67.210.105, and keeps a v6 or
     * otherwise unparsable answer at the end instead of dropping it.
     */
    function ipValue(address) {
      const parts = String(address).split('.')
      if (parts.length !== 4) return Number.POSITIVE_INFINITY
      let value = 0
      for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return Number.POSITIVE_INFINITY
        value = value * 256 + Number(part)
      }
      return value
    }

    function sortAddresses(addresses) {
      if (!Array.isArray(addresses)) return []
      return [...addresses].sort((left, right) => {
        const delta = ipValue(left) - ipValue(right)
        return delta !== 0 ? delta : String(left).localeCompare(String(right))
      })
    }

    function ago(seconds, t) {
      if (seconds === undefined || seconds === null || seconds <= 0) return t('never')
      if (seconds < 90) return `${Math.round(seconds)}${t('seconds')}`
      if (seconds < 5400) return `${Math.round(seconds / 60)}${t('minutes')}`
      return `${Math.round(seconds / 3600)}${t('hours')}`
    }

    function orderedCandidates(candidates, benchmarks) {
      const group = (entry) => {
        const bench = benchmarks?.[entry.ip]
        const sampled = Array.isArray(bench?.samples) && bench.samples.length > 0
        if (bench?.scoringVersion === 2 && !bench.historical) {
          if (bench.eliminated) return 2
          if (Number.isFinite(bench.stabilityScore) && bench.stabilityScore > 0) return 0
          return sampled ? 1 : 4
        }
        return sampled || Number.isFinite(bench?.tps) ? 3 : 4
      }
      const value = (candidate, key, fallback = 0) => {
        const bench = benchmarks?.[candidate.ip]
        return bench?.scoringVersion === 2 && !bench.historical && Number.isFinite(bench[key]) ? bench[key] : fallback
      }
      const rtt = (candidate) => Number.isFinite(candidate.rtt) ? candidate.rtt : Infinity
      // Keep this tuple identical to the server. Old scores, including another v2 cohort, are incomparable.
      return [...(candidates ?? [])].sort((a, b) => group(a) - group(b) ||
        value(b, 'stabilityScore') - value(a, 'stabilityScore') ||
        value(b, 'reliableRuns') - value(a, 'reliableRuns') ||
        value(b, 'effectiveTps') - value(a, 'effectiveTps') ||
        value(b, 'conservativeTps') - value(a, 'conservativeTps') ||
        value(a, 'ttftMs', Infinity) - value(b, 'ttftMs', Infinity) ||
        rtt(a) - rtt(b) || String(a.ip).localeCompare(String(b.ip)))
    }

    // Skipped slots are display-only: samples continue to mean real attempts in their original order.
    function sampleSlots(bench) {
      if (!Array.isArray(bench?.samples)) return null
      const skipped = Number.isSafeInteger(bench.skippedRuns) && bench.skippedRuns > 0 ? bench.skippedRuns : 0
      const pending = Number.isSafeInteger(bench.pendingRuns) && bench.pendingRuns > 0 ? bench.pendingRuns : 0
      const planned = Number.isSafeInteger(bench.plannedRuns) && bench.plannedRuns > 0 ? bench.plannedRuns : 0
      const count = Math.max(bench.samples.length + skipped + pending, planned)
      return Array.from({ length: count }, (_, index) => ({
        sample: bench.samples[index],
        missing: index >= bench.samples.length && index < bench.samples.length + skipped ? 'sampleSkipped' : 'sampleMissing',
      }))
    }

    function sampleValues(bench, t) {
      const slots = sampleSlots(bench)
      if (slots === null) return t('sampleLegacy')
      const values = slots.map(({ sample, missing }) => {
        if (!sample) return t(missing)
        if (sample.cancelled || sample.error === 'test stopped') return t('sampleStopped')
        if (Number.isFinite(sample.tps)) return `${sample.tps.toFixed(1)}${sample.flags?.length ? '⚠' : ''}`
        return sample.error ? t('sampleFailed') : t('sampleUnmeasurable')
      })
      return `(${values.join(', ')})`
    }

    function sampleDetails(bench, t) {
      const slots = sampleSlots(bench)
      if (slots === null) return t('sampleLegacy')
      return slots.map(({ sample, missing }, index) => {
        const label = `${t('run')}${index + 1}: `
        if (!sample) return `${label}${t(missing)}${missing === 'sampleSkipped' && bench.skippedReason ? `; ${bench.skippedReason}` : ''}`
        const flags = (sample.flags ?? []).map((flag) => t(`sampleReasons.${flag}`)).join('; ')
        const state = sample.cancelled || sample.error === 'test stopped' ? `${t('sampleStopped')}; ` : sample.error ? `${t('sampleFailed')}; ` : ''
        const scored = Number.isFinite(sample.scoredTps) ? `; ${t('scoredTps')}: ${sample.scoredTps}` : ''
        const timeout = Number.isFinite(sample.timeoutMs) && sample.timeoutMs > 0 ? `; ${t('timeoutBudget')}: ${sample.timeoutMs} ms` : ''
        return `${label}${state}${sample.tps ?? '-'} TPS; ${sample.outputTokens ?? '-'} tokens; ${sample.decodeMs ?? '-'} ms${scored}${timeout}${flags ? `; ${flags}` : ''}`
      }).join('\n')
    }

    function SampleBadges({ bench, t }) {
      if (!Array.isArray(bench?.samples)) return h('div', { style: { ...S.muted, whiteSpace: 'normal' } }, t('sampleLegacy'))
      if (sampleSlots(bench).length === 0) return null
      const labels = sampleValues(bench, t).slice(1, -1).split(', ')
      const details = sampleDetails(bench, t).split('\n')
      return h('div', { style: S.sampleBadges, 'aria-label': t('samplesLabel') },
        labels.map((value, index) => h('span', {
          key: index, title: details[index] ?? `${t('run')}${index + 1}: ${value}`,
          style: { ...S.sampleBadge, ...(bench.samples[index]?.flags?.length ? { color: 'var(--dsw-alias-state-warn-primary)' } : {}) },
        }, h('span', { style: { opacity: 0.7, fontSize: 10 } }, `${index + 1}·`), value)),
      )
    }

    function ResultIdentity({ row, selected, recommended, t }) {
      return h('div', { style: { ...S.resultMetric, minWidth: 0 } },
        h('div', { style: { ...S.mono, fontWeight: selected || recommended ? 600 : 500, overflowWrap: 'anywhere' } }, row.ip),
        h('div', { style: { ...S.muted, display: 'flex', flexWrap: 'wrap', gap: 5, fontSize: 11 } },
          h('span', null, row.colo ?? '?'),
          selected ? h('span', { style: S.best }, `✓ ${t('inUse')}`) : null,
          recommended ? h('span', { style: S.best }, t('recommended')) : null,
        ),
      )
    }

    function ResultApply({ ip, selected, disabled, onChoose, label, bench, t }) {
      if (selected) return h('span', { style: { ...S.muted, display: 'block', textAlign: 'center', padding: '7px 0' } }, `✓ ${t('inUse')}`)
      const warning = bench?.scoringVersion === 2 && !bench.historical ? bench.confirmed !== true ? t('incompleteRetest') : ''
        : bench && ((bench.samples?.length ?? 0) > 0 || Number.isFinite(bench.tps) || Number.isFinite(bench.stabilityScore)) ? t('legacyRecord') : ''
      return h('button', {
        type: 'button', className: 'dsh-best-ip-result-apply',
        style: { ...S.btn, ...S.resultApply }, disabled,
        title: `${label ?? t('use')}: ${ip}${warning ? ` · ${warning}` : ''}`, 'aria-label': `${label ?? t('use')}: ${ip}`,
        onClick: () => onChoose(ip),
      }, label ?? t('use'))
    }

    function ResultSpeed({ bench, t }) {
      return h('div', { style: S.resultMetric },
        h('div', { style: { fontWeight: 600, fontVariantNumeric: 'tabular-nums' } }, Number.isFinite(bench?.tps) ? bench.tps.toFixed(1) : '—'),
        bench ? h(SampleBadges, { bench, t }) : null,
        Number.isFinite(bench?.outputTokens) ? h('div', { style: { ...S.muted, fontSize: 11 } }, `${t('tokens')}: ${bench.outputTokens}`) : null,
      )
    }

    function ResultScore({ bench, t }) {
      const samples = Array.isArray(bench?.samples) ? bench.samples : []
      const measured = samples.length > 0 || (bench?.runs ?? 0) > 0 || Number.isFinite(bench?.tps) || Number.isFinite(bench?.stabilityScore)
      const v2 = bench?.scoringVersion === 2 && !bench.historical
      const eliminated = v2 && (bench.eliminated === true || bench.skippedRuns > 0)
      const status = !v2 ? measured ? 'legacyRecord' : 'untested'
        : eliminated ? 'eliminated' : bench.confirmed === true && bench.rankEligible === true ? 'confirmed' : measured ? 'provisional' : 'untested'
      const successful = bench?.successfulRuns ?? (samples.length > 0
        ? samples.filter((sample) => sample && !sample.cancelled && !sample.error).length
        : Math.max(0, (bench?.runs ?? 0) - (bench?.failed ?? 0) - (bench?.cancelled ?? 0)))
      const failed = bench?.failed ?? samples.filter((sample) => sample && !sample.cancelled && sample.error && sample.error !== 'test stopped').length
      const confidence = Number.isFinite(bench?.measurementConfidence) ? `\n${t('measurementConfidence')}: ${(bench.measurementConfidence * 100).toFixed(0)}%` : ''
      const context = v2 ? bench.scoreContext : undefined
      const shared = context ? `\n${t('scoreReference')}: ${context.speedReference} TPS\n${t('scoreCap')}: ${Number.isFinite(context.speedCap) ? `${context.speedCap} TPS` : t('scoreUncapped')}` : ''
      const calibration = context?.calibrated === false ? `\n${t('scoreUncalibrated')}` : ''
      const counts = `${successful} ${t('successfulSamples')} · ${failed} ${t('failedSamples')} · ${bench?.reliableRuns ?? 0} ${t('reliableSamples')}`
      return h('div', { style: S.resultMetric, title: `${v2 ? t('scoreHint') : t('legacyRecord')}${shared}${confidence}${calibration}` },
        // A single trustworthy run has a useful provisional score even though it cannot be recommended yet.
        h('div', { style: { fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, Number.isFinite(bench?.stabilityScore) ? bench.stabilityScore.toFixed(1) : '—'),
        h('div', { style: { ...S.muted, fontSize: 11 } }, t(status)),
        measured || eliminated ? h('div', { style: { ...S.muted, fontSize: 11 } }, counts) : null,
        v2 && measured && (bench.reliableRuns ?? 0) < 2 ? h('div', { style: { ...S.muted, fontSize: 11 } }, t('samplesInsufficient')) : null,
      )
    }

    function ResultTiming({ row, bench, t }) {
      const samples = Array.isArray(bench?.samples) ? bench.samples : []
      const attempted = samples.length || bench?.runs || 0
      const cancelled = (bench?.cancelled ?? 0) > 0 || samples.some((sample) => sample?.cancelled || sample?.error === 'test stopped')
      const failed = attempted > 0 && ((bench?.failed ?? 0) > 0 || samples.some((sample) => sample?.error && !sample.cancelled && sample.error !== 'test stopped') ||
        (!cancelled && (bench?.error !== undefined || bench?.eligible === false)))
      return h('div', { style: S.resultMetric },
        h('div', { style: S.muted }, `${t('ping')}: ${Number.isFinite(row.rtt) ? `${row.rtt} ms` : '—'}`),
        h('div', { style: S.muted }, `${t('ttft')}: ${Number.isFinite(bench?.ttftMs) ? `${bench.ttftMs} ms` : failed ? t('unusable') : cancelled ? t('sampleStopped') : t('untested')}`),
      )
    }

    function Panel({ t }) {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [note, setNote] = useState(null)
      const [busy, setBusy] = useState(false)
      const [running, setRunning] = useState(null)
      const [activeRunId, setActiveRunId] = useState(null)
      const [stopping, setStopping] = useState(false)
      const [progress, setProgress] = useState(null)
      const [timing, setTiming] = useState(false)
      const [timeResult, setTimeResult] = useState(null)
      // Kept apart from `timeResult` so an in-flight poll clearing the live
      // progress cannot blank the finished summary.
      const [stickySummary, setStickySummary] = useState(null)
      const [timeProgress, setTimeProgress] = useState(null)
      const [timeRuns, setTimeRuns] = useState(3)
      const [draft, setDraft] = useState(null)
      const [customBenchmarkIpLimit, setCustomBenchmarkIpLimit] = useState(false)
      const [message, setMessage] = useState(null)
      const [showResolvers, setShowResolvers] = useState(false)
      const [newServer, setNewServer] = useState('')

      const load = useCallback(async () => {
        try {
          const next = await call('/state')
          setState(next)
          setDraft({
            enabled: next.enabled,
            dnsServers: next.servers,
            scanEdges: next.scanEdges,
            maxBenchmarkIps: next.maxBenchmarkIps ?? 0,
            includeSubdomains: next.includeSubdomains,
            fallbackToSystem: next.fallbackToSystem,
          })
          setCustomBenchmarkIpLimit(![0, 10].includes(next.maxBenchmarkIps ?? 0))
          setError(null)
          // Returned so a caller can read the just-refreshed measurements, which
          // is how a missed progress snapshot still yields a visible summary.
          return next
        } catch (problem) {
          setError(problem?.message ?? String(problem))
          return undefined
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      useEffect(() => {
        if (message === null && state !== null) setMessage(state.benchmarkMessage ?? t('message') ?? '')
      }, [message, state, t])

      const selection = state?.defaultSelection
      const benchmarkBlocked = state?.benchmarkAvailability?.supported === false
      const measurement = (() => {
        if (state === null || selection === undefined) return undefined
        return (state.measurements ?? []).find((entry) => entry.provider === selection.provider)
      })()

      const benchmarkIpLimitInvalid = draft !== null &&
        (!Number.isSafeInteger(draft.maxBenchmarkIps) || draft.maxBenchmarkIps < 0 || (customBenchmarkIpLimit && draft.maxBenchmarkIps === 0))

      const dirty =
        state !== null &&
        draft !== null &&
        (draft.enabled !== state.enabled ||
          draft.dnsServers.slice().join(',') !== state.servers.slice().join(',') ||
          draft.scanEdges !== state.scanEdges ||
          draft.maxBenchmarkIps !== (state.maxBenchmarkIps ?? 0) ||
          draft.includeSubdomains !== state.includeSubdomains ||
          draft.fallbackToSystem !== state.fallbackToSystem)

      const save = async () => {
        if (draft === null || benchmarkIpLimitInvalid) return
        setBusy(true)
        setNote(null)
        setError(null)
        try {
          await call('/save', {
            enabled: draft.enabled,
            dnsServers: draft.dnsServers,
            scanEdges: draft.scanEdges,
            maxBenchmarkIps: draft.maxBenchmarkIps,
            includeSubdomains: draft.includeSubdomains,
            fallbackToSystem: draft.fallbackToSystem,
          })
          await load()
          setNote(t('saved'))
        } catch (problem) {
          setError(`${t('saveFailed')}: ${problem?.message ?? String(problem)}`)
        } finally {
          setBusy(false)
        }
      }

      // Poll the live run until it reports a terminal stage. The server returns
      // 202 immediately, so every number shown here is real progress rather than
      // an animation guessing at it.
      const pollUntilDone = useCallback(async (onTick, runId) => {
        let sawTerminal = null
        for (;;) {
          // Poll/identity errors propagate to the action's catch; returning a
          // partial snapshot would let load() erase the error and appear idle.
          const value = await call('/progress')
          const progress = value?.progress ?? null
          const lastRun = value?.lastRun ?? null
          if (progress && runId && progress.runId !== runId) throw new Error('measurement was replaced by another run')
          if (!progress && lastRun && runId && lastRun.runId !== runId) throw new Error('measurement outcome is no longer available')
          onTick(progress)
          if (progress !== null) {
            if (progress.stage === 'done' || progress.stage === 'stopped' || progress.stage === 'failed') return progress
            sawTerminal = progress
          } else {
            // The live snapshot is cleared shortly after a run ends. Falling back
            // to the durable outcome is what keeps the summary on screen: before
            // this, a poll landing after the clear returned null and the result
            // silently disappeared.
            if (lastRun !== null && (lastRun.stage === 'done' || lastRun.stage === 'failed' || lastRun.stage === 'stopped')) {
              return lastRun
            }
            // No live run and no stored outcome: the run never started.
            return sawTerminal
          }
          await new Promise((resolve) => setTimeout(resolve, 600))
        }
      }, [])

      const runAutoTest = async (testOnly = true) => {
        if (selection === undefined || benchmarkIpLimitInvalid) return
        // Mode belongs to this click, never to a remembered/global switch.
        testOnly = testOnly !== false
        setRunning(testOnly ? 'test' : 'apply')
        setStopping(false)
        setActiveRunId(null)
        setProgress(null)
        setError(null)
        setNote(null)
        try {
          const started = await call('/auto', {
            provider: selection.provider,
            model: selection.model,
            testOnly,
            maxBenchmarkIps: draft.maxBenchmarkIps,
            message: message === null || message.trim() === '' ? undefined : message.trim(),
          })
          setActiveRunId(started.runId)
          const final = await pollUntilDone((progress) => {
            setProgress(progress)
          }, started.runId)
          await load()
          const runError = describeRunError(final, t)
          if (runError) setError(runError)
          if (final?.stage === 'stopped') setNote(t('stoppedHint'))
          if (final?.stage === 'done') {
            setNote(final.defaultChanged ? t('defaultChangedHint') : final.applied ? t('applies') : final.recommended ? t('previewDone').replace('{ip}', final.recommended) : t('noRecommendationHint'))
          }
        } catch (problem) {
          setError(problem?.message ?? String(problem))
        } finally {
          setRunning(null)
          setActiveRunId(null)
          setStopping(false)
          setProgress(null)
        }
      }

      // Time the address in use, without re-probing or changing the selection.
      // Backgrounded like /auto, so the three runs appear one by one instead of
      // the whole thing being one opaque wait.
      const runTimeCurrent = async () => {
        if (selection === undefined) return
        setTiming(true)
        setStopping(false)
        setActiveRunId(null)
        setTimeResult(null)
        setStickySummary(null)
        setTimeProgress(null)
        setError(null)
        setNote(null)
        try {
          const started = await call('/time', {
            provider: selection.provider,
            model: selection.model,
            testOnly: true,
            message: message === null || message.trim() === '' ? undefined : message.trim(),
          })
          setActiveRunId(started.runId)
          setTimeRuns(started?.runs ?? 3)
          const final = await pollUntilDone((snapshot) => {
            setTimeProgress(snapshot)
          }, started.runId)
          if (final?.stage === 'stopped') setNote(t('stoppedHint'))
          // Adopt the settled summary the run itself reported.
          if (final?.summary !== undefined) {
            setTimeResult({ ip: final.address ?? started?.ip, runs: started?.runs ?? 3, summary: final.summary })
            setStickySummary({ ip: final.address ?? started?.ip, runs: started?.runs ?? 3, summary: final.summary })
          }
          await load()
          const runError = describeRunError(final, t)
          if (runError) setError(runError)
        } catch (problem) {
          setError(problem?.message ?? String(problem))
        } finally {
          setTiming(false)
          setActiveRunId(null)
          setStopping(false)
        }
      }

      const stopTest = async () => {
        if (!activeRunId || stopping) return
        setStopping(true)
        setError(null)
        setNote(t('stoppingHint'))
        try {
          await call('/stop', { runId: activeRunId })
        } catch (problem) {
          setStopping(false)
          setError(problem?.message ?? String(problem))
        }
      }

      // Add one discovery source. Only a plausible address is accepted: a typo
      // here would otherwise fail silently at probe time.
      const addServer = () => {
        const candidate = newServer.trim()
        if (candidate === '') return
        const looksLikeAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(candidate) || /^[0-9a-f:]+$/i.test(candidate)
        if (!looksLikeAddress) {
          setError(t('badServer'))
          return
        }
        if (!draft.dnsServers.includes(candidate)) {
          setDraft({ ...draft, dnsServers: [...draft.dnsServers, candidate] })
          setError(null)
        }
        setNewServer('')
      }

      const choose = async (ip) => {
        if (measurement === undefined) return
        setError(null)
        try {
          const result = await call('/select', { host: measurement.hostname, provider: selection.provider, ip, testOnly: false })
          await load()
          if (result.result?.saveError) setError(result.result.saveError)
          const bench = measurement.benchmarks?.[ip]
          setNote(bench?.scoringVersion === 2 && !bench.historical ? bench.confirmed !== true ? t('appliedIncompleteHint') : null
            : bench && ((bench.samples?.length ?? 0) > 0 || Number.isFinite(bench.tps) || Number.isFinite(bench.stabilityScore)) ? t('appliedLegacyHint') : null)
        } catch (problem) {
          setError(problem?.message ?? String(problem))
        }
      }

      const forget = async () => {
        if (measurement === undefined) return
        try {
          await call('/forget', { host: measurement.hostname, provider: selection.provider, testOnly: false })
          await load()
          setNote(null)
        } catch (problem) {
          setError(problem?.message ?? String(problem))
        }
      }

      if (error !== null && state === null) {
        return h('div', { style: S.page }, h('div', { style: S.err }, `${t('loadFailed')}: ${error}`))
      }
      if (state === null || draft === null) {
        return h('div', { style: S.page }, h('div', { style: S.muted }, '…'))
      }

      const benchmarkCost = benchmarkIpLimitInvalid ? null : describeBenchmarkCost(state, draft.maxBenchmarkIps, t)
      const benchmarked = measurement?.benchmarks ?? {}
      const sortedRows = orderedCandidates(measurement?.candidates, benchmarked)
      const recommendedIp = sortedRows.some((row) => row.ip === measurement?.recommended && benchmarked[row.ip]?.scoringVersion === 2 && !benchmarked[row.ip]?.historical &&
        benchmarked[row.ip]?.rankEligible === true && !benchmarked[row.ip]?.eliminated && Number.isFinite(benchmarked[row.ip]?.stabilityScore) && benchmarked[row.ip].stabilityScore > 0)
        ? measurement.recommended : undefined

      const statItems = [
        ['statPinned', state.pinned],
        ['statCache', state.cacheHits],
        ['statFailures', state.failures],
        ['statFallbacks', state.fallbacks],
      ]

      return h(
        'div',
        { style: S.page },

        // Style rule for the progress animation, scoped by prefix.
        h('style', null, '@keyframes dsh-best-ip-slide{0%{left:-35%}100%{left:100%}}' + RESULTS_LAYOUT),

        // Header: exactly one provider and one model
        h('div', { style: S.card },
          h('h2', { style: S.title }, t('title')),
          h('p', { style: S.subtitle }, t('subtitle')),
          selection === undefined
            ? h('div', { style: S.hint }, t('noDefault'))
            : h('div', { style: S.chips },
                h('span', { style: S.label }, t('defaultModel')),
                h('span', { style: { ...S.chip, ...S.mono } }, selection.provider),
                selection.model !== undefined
                  ? h('span', { style: { ...S.chip, ...S.mono } }, selection.model)
                  : null,
                selection.reasoningEffort !== undefined
                  ? h('span', { style: S.chip }, selection.reasoningEffort)
                  : null,
              ),
          benchmarkBlocked ? h('div', { style: S.hint, role: 'status' }, t('benchmarkUnavailable').replace('{reason}', t(`benchmarkReasons.${state.benchmarkAvailability.reasonCode}`))) : null,
          h(Toggle, {
            on: draft.enabled,
            label: t('enabled'),
            hint: t('enabledHint'),
            disabled: timing || running !== null,
            onChange: (value) => setDraft({ ...draft, enabled: value }),
          }),
          dirty ? h('button', { type: 'button', style: S.btn, disabled: busy || timing || running !== null || benchmarkIpLimitInvalid, onClick: save }, t('save')) : null,
        ),

        // Two explicit actions avoid a hidden, remembered apply mode.
        h('div', { style: S.card },
          h('div', { style: S.row },
            h('div', { style: { flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: 4 } },
              h('div', { style: S.label }, t('speedTest')),
              h('div', { style: S.hint }, t('speedTestHint')),
            ),
            // The address in use, right next to the action that changes it.
            h('span', { style: { ...S.chip, ...S.mono } },
              `${t('current')}: ${measurement?.activeAddress ?? t('systemDns')}`,
              measurement?.activeAddress !== undefined && measurement?.selectedSource !== undefined
                ? h('span', { style: { ...S.muted, marginLeft: 4 } }, measurement.selectedSource)
                : null,
            ),
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
              h('label', { style: { ...S.label, display: 'flex', gap: 6, alignItems: 'center' }, title: t('benchmarkIpLimitHint') },
                t('maxBenchmarkIps'),
                h('select', {
                  style: { ...S.input, flex: '0 0 auto', width: 'auto' },
                  'aria-label': t('maxBenchmarkIps'),
                  disabled: busy || timing || running !== null,
                  value: customBenchmarkIpLimit ? 'custom' : String(draft.maxBenchmarkIps),
                  onChange: (event) => {
                    const custom = event.target.value === 'custom'
                    setCustomBenchmarkIpLimit(custom)
                    setDraft({ ...draft, maxBenchmarkIps: custom ? draft.maxBenchmarkIps || '' : Number(event.target.value) })
                  },
                },
                  h('option', { value: '10' }, t('benchmarkIpLimitCount').replace('{count}', 10)),
                  h('option', { value: 'custom' }, t('benchmarkIpLimitCustom')),
                  h('option', { value: '0' }, t('benchmarkIpLimitAll')),
                ),
              ),
              customBenchmarkIpLimit ? h('input', {
                type: 'number', min: 1, max: Number.MAX_SAFE_INTEGER, step: 1,
                style: { ...S.input, flex: '0 1 100px', width: 100 },
                'aria-label': `${t('maxBenchmarkIps')} (${t('benchmarkIpLimitCustom')})`,
                'aria-invalid': benchmarkIpLimitInvalid,
                disabled: busy || timing || running !== null,
                value: draft.maxBenchmarkIps,
                onChange: (event) => setDraft({ ...draft, maxBenchmarkIps: event.target.value === '' ? '' : Number(event.target.value) }),
              }) : null,
              draft.maxBenchmarkIps !== (state.maxBenchmarkIps ?? 0) ? h('button', {
                type: 'button', style: S.btn,
                disabled: busy || timing || running !== null || benchmarkIpLimitInvalid, onClick: save,
              }, busy ? t('saving') : t('save')) : null,
              h('button', {
                type: 'button',
                title: t('autoTestTitle'),
                style: { ...S.primary, opacity: timing || busy || running !== null || selection === undefined || benchmarkBlocked || benchmarkIpLimitInvalid ? 0.55 : 1 },
                disabled: timing || busy || running !== null || selection === undefined || benchmarkBlocked || benchmarkIpLimitInvalid,
                onClick: () => runAutoTest(true),
              }, running === 'test' ? t('testing') : t('autoTest')),
              h('button', {
                type: 'button',
                title: t('autoApplyTitle'),
                style: { ...S.btn, height: 32, opacity: timing || busy || running !== null || selection === undefined || benchmarkBlocked || benchmarkIpLimitInvalid ? 0.55 : 1 },
                disabled: timing || busy || running !== null || selection === undefined || benchmarkBlocked || benchmarkIpLimitInvalid,
                onClick: () => runAutoTest(false),
              }, running === 'apply' ? t('testingAndApply') : t('autoTestAndApply')),
            ),
          ),
          h('div', { style: S.hint }, t('benchmarkIpLimitHint')),
          benchmarkCost ? h('div', { style: { ...S.hint, display: 'flex', alignItems: 'center', gap: 6 } },
            h('span', null, benchmarkCost.summary),
            h('button', {
              type: 'button', style: S.costInfo,
              title: benchmarkCost.details,
              'aria-label': t('benchmarkCostDetails'),
              'aria-description': benchmarkCost.details,
            }, '!'),
          ) : null,
          benchmarkIpLimitInvalid ? h('div', { style: S.err, role: 'alert' }, t('benchmarkIpLimitInvalid')) : null,
          h('div', { style: S.hint }, t('actionsHint')),
          running !== null || timing ? h('button', {
            type: 'button', style: { ...S.btn, alignSelf: 'flex-start' },
            disabled: !activeRunId || stopping, onClick: stopTest,
          }, stopping ? t('stopping') : t('stop')) : null,
          running !== null
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                h('div', { style: S.progress }, h('div', { style: S.progressBar })),
                h('div', { style: S.muted }, describeProgress(progress, t)),
                // One row per address with its runs side by side, so the confirm
                // phase reads as "these 3 addresses, 3 runs each" instead of an
                // interleaved stream of individual requests.
                h(RunsTable, { progress, t }),
              )
            : null,
          note !== null ? h('div', { style: S.ok, role: 'status' }, note) : null,
          error !== null ? h('div', { style: { ...S.err, whiteSpace: 'pre-line' }, role: 'alert' }, error) : null,
          h('div', { style: S.row },
            h('div', { style: { flex: '1 1 280px', display: 'flex', flexDirection: 'column', gap: 4 } },
              h('div', { style: S.label }, t('message')),
              h('div', { style: S.hint }, t('messageHint')),
            ),
            h('input', {
              style: { ...S.input, flex: '2 1 320px' },
              value: message ?? '',
              onChange: (event) => setMessage(event.target.value),
            }),
            // Time the address in use with three requests — no re-probe, no
            // change of selection, so "is the current pin still good?" is cheap.
            h('button', {
              type: 'button',
              style: { ...S.btn, opacity: timing || running !== null ? 0.55 : 1 },
              disabled: timing || busy || running !== null || selection === undefined || benchmarkBlocked,
              onClick: runTimeCurrent,
            }, timing ? t('timingNow') : t('timeNow')),
          ),
          // Live runs while testing: the address as one row, its three runs laid
          // out left to right.
          timing || timeProgress !== null
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                h('div', { style: { ...S.muted, ...S.mono } },
                  `${t('testingAddress')} ${timeProgress?.address ?? measurement?.selected ?? '-'} · `,
                  `${timeProgress?.timing ?? 0}/${timeProgress?.timingTotal ?? timeRuns} ${t('runs')}`,
                ),
                h(RunsTable, { progress: timeProgress, t }),
              )
            : null,
          // Prefer the durable summary: an in-flight poll clearing the live
          // progress must not blank a finished result.
          (stickySummary ?? timeResult) !== null
            ? (() => {
                const shown = stickySummary ?? timeResult
                return h('div', { style: { ...S.mono, display: 'flex', flexDirection: 'column', gap: 2 } },
                  h('div', { style: S.label }, `${t('timeNowResult')} · ${shown.ip ?? ''}`),
                  // TPS only: that is the figure this button exists to report.
                  h('div', { title: sampleDetails(shown.summary, t), style: S.muted }, sampleValues(shown.summary, t)),
                  h('div', null,
                    `TPS ${shown.summary?.tps === null || shown.summary?.tps === undefined ? '-' : shown.summary.tps} · `,
                    `${shown.runs ?? 3} × ${shown.summary?.outputTokens ?? '-'} ${t('tokens')}`,
                  ),
                  // The spread, so a single median is not mistaken for a precise
                  // figure: the same address has measured 132 and 288 t/s.
                  shown.summary?.tpsMin !== null && shown.summary?.tpsMin !== undefined
                    ? h('div', { style: S.muted },
                        `${t('range')}: TPS ${shown.summary.tpsMin}–${shown.summary.tpsMax}`,
                      )
                    : null,
                )
              })()
            : null,
        ),

        // Results for the default provider only
        h('div', { style: S.card },
          h('div', { style: S.row },
            h('div', { style: S.label }, t('addresses')),
            measurement !== undefined
              ? h('span', { style: S.muted }, t('probedAgo').replace('{age}', ago(Math.max(0, (Date.now() - (measurement.probedAt ?? 0)) / 1000), t)))
              : null,
          ),
          measurement === undefined
            ? h('div', { style: S.hint }, t('noAddresses'))
             : h('div', { style: { ...S.resultsSurface, display: 'flex', flexDirection: 'column', gap: 10 } },
                 h('div', { style: { ...S.chips, minWidth: 0 } },
                   h('span', { style: { ...S.chip, ...S.mono, whiteSpace: 'normal', overflowWrap: 'anywhere' } }, measurement.hostname),
                   h('span', { style: { ...S.chip, ...S.mono, whiteSpace: 'normal', overflowWrap: 'anywhere' } }, `${t('inUse')}: ${measurement.activeAddress ?? t('systemDns')}`),
                   recommendedIp ? h('span', { style: { ...S.chip, ...S.mono, whiteSpace: 'normal', overflowWrap: 'anywhere' } }, `${t('recommended')}: ${recommendedIp}`) : null,
                   recommendedIp && recommendedIp !== measurement.activeAddress
                     ? h('div', { style: { width: 148, maxWidth: '100%' } }, h(ResultApply, { ip: recommendedIp, bench: benchmarked[recommendedIp], disabled: busy || timing || running !== null || benchmarkBlocked, onChoose: choose, label: t('applyRecommended'), t }))
                     : null,
                 ),
                 // Persisted empty results need a message even after reopening the page.
                 sortedRows.length === 0 && running === null
                   ? h('div', { style: S.hint, role: 'status' }, t(measurement.stopped ? 'stoppedHint' : 'noValidIp'))
                   : null,
                 sortedRows.length > 0 && h('div', { className: 'dsh-best-ip-results-wide', style: S.resultViewport },
                   h('table', { style: S.table },
                     h('colgroup', null,
                       h('col', { style: { width: 158 } }), h('col', null), h('col', { style: { width: 104 } }), h('col', { style: { width: 122 } }), h('col', { style: { width: 132 } }),
                     ),
                     h('thead', null, h('tr', null,
                       h('th', { scope: 'col', style: { ...S.th, ...S.resultIdentity, top: 0, zIndex: 5, background: 'var(--dsw-alias-bg-layer-2)' } }, t('ipAndEdge')),
                       h('th', { scope: 'col', style: S.th }, t('medianTps')),
                       h('th', { scope: 'col', style: S.th, title: t('scoreHint') }, t('score')),
                       h('th', { scope: 'col', style: S.th }, t('timing')),
                       h('th', { scope: 'col', style: { ...S.th, ...S.resultAction, top: 0, zIndex: 5, background: 'var(--dsw-alias-bg-layer-2)' } }, t('action')),
                     )),
                     h('tbody', null, sortedRows.map((row) => {
                       const bench = benchmarked[row.ip]
                       const selected = measurement.activeAddress === row.ip
                       const recommended = row.ip === recommendedIp
                       return h('tr', { key: row.ip },
                         h('td', { style: { ...S.td, ...S.resultIdentity } }, h(ResultIdentity, { row, selected, recommended, t })),
                         h('td', { style: S.td }, h(ResultSpeed, { bench, t })),
                         h('td', { style: { ...S.td, ...(recommended ? S.best : {}) } }, h(ResultScore, { bench, t })),
                         h('td', { style: S.td }, h(ResultTiming, { row, bench, t })),
                         h('td', { style: { ...S.td, ...S.resultAction } }, h(ResultApply, { ip: row.ip, bench, selected, disabled: busy || timing || running !== null || benchmarkBlocked, onChoose: choose, t })),
                       )
                     })),
                   ),
                 ),
                 h('div', { className: 'dsh-best-ip-results-cards', style: S.resultCards }, sortedRows.map((row) => {
                   const bench = benchmarked[row.ip]
                   const selected = measurement.activeAddress === row.ip
                   const recommended = row.ip === recommendedIp
                   return h('article', { key: row.ip, style: S.resultCard, 'aria-label': row.ip },
                     h('div', { style: S.resultCardHeader },
                       h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, h(ResultIdentity, { row, selected, recommended, t })),
                       h('div', { style: { flex: '0 0 112px', maxWidth: '48%' } }, h(ResultApply, { ip: row.ip, bench, selected, disabled: busy || timing || running !== null || benchmarkBlocked, onChoose: choose, t })),
                     ),
                     h('div', { style: S.resultCardMetrics },
                       h('div', { style: S.resultMetric }, h('div', { style: S.hint }, t('medianTps')), h(ResultSpeed, { bench, t })),
                       h('div', { style: S.resultMetric }, h('div', { style: S.hint }, t('score')), h(ResultScore, { bench, t })),
                       h('div', { style: S.resultMetric }, h('div', { style: S.hint }, t('timing')), h(ResultTiming, { row, bench, t })),
                     ),
                   )
                 })),
                h('div', { style: S.row },
                  h('span', { style: S.hint }, t('resultHint')),
                  h('button', { type: 'button', style: S.btn, disabled: busy || running !== null || timing, onClick: forget }, t('forget')),
                ),
              ),
        ),

        // Resolvers: discovery sources only, collapsible by default so a first
        // run shows just the button and the result.
        h('div', { style: S.card },
          h('button', {
            type: 'button',
            style: { ...S.btn, alignSelf: 'flex-start' },
            onClick: () => setShowResolvers(!showResolvers),
          }, `${showResolvers ? '▾' : '▸'} ${t('servers')}`),
          showResolvers
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4 } },
                h('div', { style: S.hint }, t('serversHint')),
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                  draft.dnsServers.map((server) =>
                    h('div', { key: server, style: S.row },
                      h('span', { style: { ...S.mono, flex: '1 1 auto' } }, server),
                      h('button', {
                        type: 'button',
                        style: S.btn,
                        onClick: () => setDraft({ ...draft, dnsServers: draft.dnsServers.filter((entry) => entry !== server) }),
                      }, '×'),
                    ),
                  ),
                  measurement?.resolvers?.length > 0
                    ? h('div', { style: { ...S.hint, display: 'flex', flexDirection: 'column', gap: 3 } },
                        h('div', { style: S.label }, t('lastAnswers')),
                        measurement.resolvers.map((entry) =>
                          h('div', { key: entry.server, style: S.mono },
                            `${entry.server}: ${entry.error !== undefined ? `⚠ ${entry.error}` : sortAddresses(entry.addresses).join(', ') || '—'}`,
                          ),
                        ),
                      )
                    : null,
                  h('div', { style: S.row },
                    h('input', {
                      style: S.input,
                      value: newServer,
                      placeholder: t('addServer'),
                      spellCheck: false,
                      onChange: (event) => setNewServer(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') addServer()
                      },
                    }),
                    h('button', { type: 'button', style: S.btn, onClick: addServer }, '+'),
                  ),
                  // Common resolvers as one-click additions: an emptied list is a
                  // valid configuration, so restoring one should not require
                  // typing an address from memory.
                  Array.isArray(state.dnsPresets) && state.dnsPresets.filter((server) => !draft.dnsServers.includes(server)).length > 0
                    ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                        h('div', { style: { ...S.hint, fontSize: 11 } }, t('presets')),
                        h('div', { style: S.chips },
                          state.dnsPresets
                            .filter((server) => !draft.dnsServers.includes(server))
                            .map((server) =>
                              h('button', {
                                key: server,
                                type: 'button',
                                style: { ...S.chip, cursor: 'pointer', fontFamily: 'inherit' },
                                onClick: () => setDraft({ ...draft, dnsServers: [...draft.dnsServers, server] }),
                              }, `+ ${server}`),
                            ),
                        ),
                      )
                    : null,
                ),
                h('div', { style: S.hint }, t('resolverRole')),
                h(Toggle, {
                  on: draft.scanEdges,
                  label: t('scanEdges'),
                  hint: t('scanEdgesHint'),
                  onChange: (value) => setDraft({ ...draft, scanEdges: value }),
                }),
                h(Toggle, {
                  on: draft.includeSubdomains,
                  label: t('subdomains'),
                  onChange: (value) => setDraft({ ...draft, includeSubdomains: value }),
                }),
                h(Toggle, {
                  on: draft.fallbackToSystem,
                  label: t('fallback'),
                  hint: t('fallbackHint'),
                  onChange: (value) => setDraft({ ...draft, fallbackToSystem: value }),
                }),
                h('div', { style: S.actions },
                  h('button', { type: 'button', style: S.btn, disabled: !dirty || busy, onClick: () => load() }, t('discard')),
                  h('button', {
                    type: 'button',
                    style: { ...S.primary, opacity: !dirty || busy || timing || running !== null || benchmarkIpLimitInvalid ? 0.55 : 1 },
                    disabled: !dirty || busy || timing || running !== null || benchmarkIpLimitInvalid,
                    onClick: save,
                  }, busy ? t('saving') : t('save')),
                ),
              )
            : null,
        ),

        // Why, and activity
        h('div', { style: S.card },
          h('div', { style: S.label }, t('why')),
          h('div', { style: S.hint }, t('whyBody')),
          h('div', { style: S.stats },
            statItems.map(([key, value]) =>
              h('div', { key, style: S.stat },
                h('span', { style: S.statValue }, String(value ?? 0)),
                h('span', { style: S.statLabel }, t(key)),
              ),
            ),
          ),
          state.statePath !== undefined
            ? h('div', { style: { ...S.hint, ...S.mono } }, `${t('storage')}: ${state.statePath}`)
            : null,
        ),
      )
    }

    function apply(ctx) {
      const dicts = { en, zh }
      const lookup = (dict, key) => key.split('.').reduce((value, part) => value?.[part], dict)
      const fallback = (key) => lookup(dicts.zh, key) ?? lookup(dicts.en, key) ?? key
      const translate = (key) => {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        if (locale === undefined) return fallback(key)
        try {
          return locale.bind(NS)(key) || fallback(key)
        } catch {
          return fallback(key)
        }
      }

      ctx.inject(['locale'], (localeCtx) => {
        localeCtx.effect(() => localeCtx.locale.register(NS, { en, zh }), 'dsh-best-ip: dictionaries')
      })

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-best-ip',
            order: 47,
            label: () => translate('section'),
            inject: () => ({ t: translate }),
          },
          Panel,
        ),
      )
    }

    return { inject: ['slots'], apply }
  },
})
