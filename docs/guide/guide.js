'use strict';

(() => {
  const systems = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };
  const tools = { native: '策划库自带 Gridiff', vscode: 'VS Code 扩展', cursor: 'Cursor 扩展' };
  const titles = ['准备与安装', '配置 Fork', '打开第一次对比', '读懂变化与快捷键', '遇到问题'];
  const marketplace = 'https://marketplace.visualstudio.com/items?itemName=sunneeyang.gridiff';
  const openvsx = 'https://open-vsx.org/extension/sunneeyang/gridiff';
  const $ = selector => document.querySelector(selector);
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const mac = () => state.os === 'macos';
  const key = value => `<kbd>${escape(value)}</kbd>`;
  const link = (url, label) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`;
  const notice = (text, type = '') => `<p class="notice ${type}">${text}</p>`;
  const image = (name, alt, caption) => `<figure><a href="assets/${name}" target="_blank" rel="noopener noreferrer" aria-label="放大图片：${alt}"><img src="assets/${name}" alt="${alt}" loading="lazy"></a><figcaption>${caption} · 点击图片可在新标签页放大。</figcaption></figure>`;
  const copyBlock = (id, label, value, helper = '') => `<div class="copy-block"><label class="copy-title" for="${id}">${label}</label><div class="copy-row"><textarea id="${id}" rows="${value.length > 90 ? 3 : value.length > 60 ? 2 : 1}" readonly spellcheck="false">${escape(value)}</textarea><button type="button" data-copy="${id}">复制</button></div><p class="copy-status" id="${id}-status" role="status">${helper}</p></div>`;

  function detectedSystem() {
    if (/Android|iPhone|iPad/i.test(navigator.userAgent) || (/MacIntel/.test(navigator.platform) && navigator.maxTouchPoints > 1)) return '';
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    if (/Mac/i.test(platform)) return 'macos';
    if (/Win/i.test(platform)) return 'windows';
    if (/Linux/i.test(platform)) return 'linux';
    return '';
  }

  function inferredRoot() {
    if (location.protocol !== 'file:') return '';
    let pathname;
    try { pathname = decodeURIComponent(location.pathname); } catch { return ''; }
    if (!/\/gridiff\/guide\/index\.html$/.test(pathname)) return '';
    const root = pathname.replace(/\/gridiff\/guide\/index\.html$/, '') || '/';
    return /^\/[a-z]:\//i.test(root) ? root.slice(1).replaceAll('/', '\\') : root;
  }

  function route() {
    const values = new URLSearchParams(location.hash.slice(1));
    const step = Number(values.get('step'));
    return {
      os: Object.hasOwn(systems, values.get('os')) ? values.get('os') : detectedSystem(),
      tool: Object.hasOwn(tools, values.get('tool')) ? values.get('tool') : 'native',
      step: Number.isInteger(step) && step >= 1 && step <= titles.length ? step : 1
    };
  }

  let state = { ...route(), root: inferredRoot() };

  function argumentValue() { return state.tool === 'cursor' ? '--wait --diff $REMOTE $LOCAL' : '$REMOTE $LOCAL'; }

  function nativePath() {
    const root = state.root.trim();
    if (!root || /[\u0000-\u001f]/.test(root)) return '';
    if (state.os === 'windows') return /^[a-z]:[\\/]/i.test(root) ? root.replaceAll('/', '\\').replace(/\\+$/, '') + '\\gridiff\\gridiff.cmd' : '';
    if (state.os === 'macos' || state.os === 'linux') return root.startsWith('/') ? root.replace(/\/+$/, '') + '/gridiff/gridiff' : '';
    return '';
  }

  function install() {
    if (state.tool === 'native') return `
      <p class="stage-lead">使用策划库里已经提供的程序，在默认浏览器中查看差异。不需要安装 VS Code、Cursor 或 Gridiff 扩展。</p>
      <ol><li>确认电脑已经安装 Fork，并能打开团队的 <strong>design 策划仓库</strong>。未安装时，先从 ${link('https://fork.dev/', 'Fork 官网')} 下载对应系统版本。</li>
      <li>更新 design 仓库，让本机拿到团队当前提供的 <strong>gridiff 文件夹及程序</strong>。仓库未更新或未取到 LFS 文件时，请先请同事协助完成。</li>
      <li>在文件管理器中找到 <code>design${state.os === 'windows' ? '\\gridiff\\gridiff.cmd' : '/gridiff/gridiff'}</code>。先记住它的位置，下一步将在 Fork 中选择这个文件。</li></ol>
      ${notice('不要双击程序来测试。它需要由 Fork 带着旧、新两份文件一起启动。')}
      <h3>你的电脑能用吗？</h3>
      <p>${state.os === 'windows' ? '仓库目前提供 Windows x64 程序。Windows ARM64 和 32 位系统没有对应的原生程序；这类电脑可改选编辑器扩展，确认编辑器本身支持该系统。' : '仓库提供 macOS 和 Linux 的 ARM64、x64 程序。顶层入口会选择对应程序，不必自己挑 CPU 版本。'}</p>
      <p>安装扩展或 Fork 需要联网；本指南和仓库自带 Gridiff 可以离线使用。</p>`;
    const editor = state.tool === 'cursor' ? 'Cursor' : 'VS Code';
    return `<p class="stage-lead">先在 ${editor} 安装 Gridiff 扩展，${state.os === 'linux' ? '再在编辑器中选择旧、新两份文件进行对比。' : `再让 Fork 把对比交给 ${editor}。`}</p>
      <ol><li>确认电脑已经安装 ${state.os === 'linux' ? '' : '<strong>Fork</strong> 和 '}<strong>${editor}</strong>。VS Code 需 1.85 或更高版本；兼容编辑器需支持相应扩展 API。未安装时，请访问 ${state.os === 'linux' ? '' : link('https://fork.dev/', 'Fork 官网') + ' 和 '}${link(state.tool === 'cursor' ? 'https://cursor.com/' : 'https://code.visualstudio.com/Download', `${editor} 官网`)} 下载。</li>
      <li>打开 ${editor}，按 ${key(mac() ? '⌘ ⇧ X' : 'Ctrl Shift X')} 打开<strong>扩展</strong>面板。在搜索框输入下方内容。</li></ol>
      ${copyBlock('extension-search', '搜索扩展', '@id:sunneeyang.gridiff', '也可搜索 Gridiff；请核对发布者，避免安装同名扩展。')}
      <ol start="3"><li>找到 <strong>Gridiff — Visual Table Diff</strong>，确认发布者为 <strong>sunneeyang</strong>，点击<strong>安装</strong>。如果编辑器提示重新加载，请按提示完成。</li></ol>
      <div class="links">${link(state.tool === 'vscode' ? marketplace : openvsx, state.tool === 'vscode' ? '查看 VS Code 官方市场页面' : '查看 Open VSX 下载页面')}</div>
      <details><summary>在扩展面板中搜不到怎么办？</summary><p>先搜索 <code>Gridiff</code>，再核对发布者。Cursor 的扩展来源会随版本变化，本指南不假定它使用 Open VSX。</p><p>仍找不到时，从 ${link(openvsx, 'Gridiff 的 Open VSX 页面')} 下载 VSIX。然后在 ${editor} 的<strong>扩展</strong>面板右上角点击 <strong>… → 从 VSIX 安装…</strong>，选择下载的文件。安装完成后回到本指南继续。</p></details>
      ${notice(`安装完成后，仅打开一个 CSV 或 XLSX 不会出现表格对比。${state.os === 'linux' ? '请在编辑器运行“Gridiff: 比较两个文件…”。' : '稍后需要从 Fork 打开“差异”，或在编辑器运行“Gridiff: 比较两个文件…”。'}`)}`;
  }

  function configure() {
    const windows = state.os === 'windows';
    const openSettings = windows ? `在 Fork 中按 ${key('Ctrl ,')} 打开首选项，进入 <strong>Integration（集成）</strong>，找到外部比较工具设置或工具列表。` : `在 Fork 中按 ${key('⌘ ,')}，或打开 <strong>Fork → Settings…（设置）→ Integration（集成）</strong>，找到 <strong>External Diff Tool</strong>。`;
    if (state.tool === 'vscode') return `<p class="stage-lead">使用 Fork 内置的 VS Code 工具配置即可。</p><ol><li>${openSettings}</li><li>选择 <strong>VSCode / Visual Studio Code</strong>${windows ? '，并确认它已设为默认或 Primary。部分版本需要右键该工具，再设为默认。' : '。'}</li><li>保留内置参数，保存设置。确认上一步已经在 VS Code 中安装 Gridiff。</li></ol>
      ${notice('选择内置 VS Code 时，不要照抄自定义工具参数。内置集成会负责传入旧、新文件。<strong>Merge Tool（合并工具）保持原来的选择即可。</strong>')}
      <p>如果没有 VS Code 选项，请先完成 VS Code 安装并重新打开 Fork 设置；也可使用自定义工具，选择 VS Code 安装目录中的命令行入口，Arguments 使用 <code>--wait --diff $REMOTE $LOCAL</code>。</p>${windows ? '<p class="helper">Windows 的工具列表与 Primary 操作参考现有版本说明和用户报告，本次未进行 Windows 实机核验。</p>' : ''}`;

    let pathSection;
    if (state.tool === 'native') {
      const example = windows ? 'D:\\work\\design' : '/Users/你的用户名/design';
      pathSection = `<p>推荐点击 <strong>File Path</strong> 右侧的文件夹按钮，实际选择策划库中的 <strong>${windows ? 'gridiff\\gridiff.cmd' : 'gridiff/gridiff'}</strong>。不要选 <code>bin</code> 里的某个平台程序。</p>
        <div class="field"><label for="project-root">可选：填写本机 design 仓库根目录，生成完整路径</label><input id="project-root" value="${escape(state.root)}" placeholder="${escape(example)}" spellcheck="false" autocomplete="off" aria-describedby="root-help"><p id="root-help" class="helper">此输入只拼接路径，不检查磁盘。示例需要换成本机的实际目录。</p></div>
        ${copyBlock('file-path', 'File Path · 程序位置', nativePath(), '请先选择文件，或填写上方本机仓库根目录。')}`;
    } else {
      pathSection = mac()
        ? `<p>在 <strong>File Path</strong> 选择 Cursor 的命令行入口。默认安装在“应用程序”时，可用下方路径；装在其他位置时请实际选择文件。</p>${copyBlock('file-path', 'File Path · Cursor 默认安装示例', '/Applications/Cursor.app/Contents/Resources/app/bin/cursor', '请确认 Cursor 确实安装在“应用程序”目录。')}`
        : `<p>在 <strong>File Path</strong> 点击文件夹按钮，进入 <strong>你实际安装的 Cursor 目录</strong>，选择 <code>resources\\app\\bin\\cursor.cmd</code>。</p>${notice('Cursor 可能按当前用户安装，也可能安装在其他目录。不要把别人的用户名和安装路径直接复制到自己的电脑。')}`;
    }
    return `<p class="stage-lead">在 Fork 中设置一个自定义外部比较工具，按顺序填好程序位置和参数。</p>
      <ol><li>${openSettings}</li><li>选择或添加 <strong>Custom（自定义）</strong>，打开 <strong>Edit Diff Tool</strong> 或自定义工具的编辑界面。</li></ol>
      ${image('fork-custom-default.png', 'macOS Fork 自定义外部比较工具的默认界面，File Path 为空，Arguments 为默认顺序', '<strong>macOS 默认界面示例，不是填写完成后的配置。</strong>图中的 Arguments 是 Fork 原始默认值，必须替换为下方给出的顺序。Windows 界面布局可能不同。')}
      <h3>① 选择程序</h3>${pathSection}
      ${mac() ? `<p class="helper">Mac 文件选择框里看不到文件？按 ${key('⌘ ⇧ G')} 打开“前往文件夹”，粘贴本页的完整 File Path，按回车，再点击“打开”。Cursor 的入口藏在应用包内，使用这个方法更方便。</p>` : ''}
      <h3>② 填写参数</h3>
      ${copyBlock('arguments', 'Arguments · 原样复制这一整行', argumentValue(), '占位符不要加引号，也不要给整行再套引号。')}
      ${notice('<strong>顺序必须是旧文件、新文件。</strong>Fork 自定义工具要写 <code>$REMOTE $LOCAL</code>。保留默认 <code>$LOCAL $REMOTE</code> 会让新增和删除方向颠倒。', 'warning')}
      <h3>③ 保存并设为当前工具</h3><p>${windows ? '保存自定义工具，并确认已把它设为默认或 Primary；部分版本需要右键该工具再设为默认。' : '点击 Edit 保存，确认 External Diff Tool 已选择刚才的自定义工具。'}<strong>Merge Tool（合并工具）保持原来的选择即可。</strong></p>${windows ? '<p class="helper">Windows 的工具列表与 Primary 操作参考现有版本说明和用户报告，本次未进行 Windows 实机核验。</p>' : ''}`;
  }

  function firstComparison() {
    return `<p class="stage-lead">从 Fork 中打开文件的差异，Gridiff 才能拿到旧、新两份内容。</p>
      <div class="flow" aria-label="首次对比流程"><span><b>1</b> 选中提交</span><span aria-hidden="true">→</span><span><b>2</b> 选中表格</span><span aria-hidden="true">→</span><span><b>3</b> 外部 Diff</span></div>
      <ol><li>先保存 Excel 或表格编辑器里的修改，再回到 Fork。</li><li>查看历史改动：在 Fork 选中一条提交，然后在下方文件列表中<strong>单击选中 .csv 或 .xlsx 文件</strong>。查看尚未提交的改动：在 <strong>Local Changes（本地修改）</strong>中选中文件。</li><li>右键该文件，选择 <strong>External Diff（外部 Diff / 外部比较）</strong>。也可先单击选中文件列表中的文件，再按 ${key(mac() ? '⌘ D' : 'Ctrl D')}；若快捷键已被修改，以菜单显示为准。不要把焦点留在上方提交列表中。</li><li>${state.tool === 'native' ? '默认浏览器会打开 Gridiff。后续从 Fork 打开其他表格时，通常会复用同一页签。若没有切到前台，请查看浏览器中已有的 Gridiff 页签。' : `${state.tool === 'cursor' ? 'Cursor' : 'VS Code'} 会打开差异标签，并自动显示 Gridiff 表格。若只看到文本或二进制差异，请按下方提示手动打开。`}</li></ol>
      <h3>确认第一次打开成功</h3><ul class="checklist"><li>页面标题是你刚选择的表格。</li><li>顶部旧、新来源的顺序符合预期。</li><li>变动数量与这次实际改动相符。例如新增两行，应看到<strong class="added-text">新增 2 条</strong>。</li></ul>
      ${notice('双击文件通常只是打开文件，不是对比。这里要使用文件右键菜单中的 External Diff。')}
      ${state.tool !== 'native' ? `<details><summary>编辑器只显示原始文本或二进制差异</summary><p>确认 Gridiff 已安装并启用。按 ${key(mac() ? '⌘ ⇧ P' : 'Ctrl Shift P')} 打开命令面板，运行 <strong>Gridiff: 以表格方式查看当前差异</strong>。也可直接运行 <strong>Gridiff: 比较两个文件…</strong>，依次选择旧文件、新文件。</p></details>` : ''}
      <h3>看完怎样退出？</h3><p>${state.tool === 'native' ? '点击网页右上角的“结束比较”可清空当前比较并停止会话。只关闭浏览器页签时，后台服务会稍后自动回收；下次仍可从 Fork 打开。' : `关掉 Gridiff 表格后，还需关闭它对应的<strong>原始文本差异标签</strong>，Fork 的等待才会结束。关闭标签可以按 ${key(mac() ? '⌘ W' : 'Ctrl W')}。`}</p>`;
  }

  function reading() {
    const shortcuts = [
      ...(state.os === 'linux' ? [] : [
        ['打开 Fork 外部比较（先单击选中文件）', key(mac() ? '⌘ D' : 'Ctrl D')],
        ['打开 Fork 设置', key(mac() ? '⌘ ,' : 'Ctrl ,')]
      ]),
      ['在控件间移动', `${key('Tab')} / ${key('Shift Tab')}`],
      ['操作选中的按钮、选项', `${key('Enter')} / ${key('Space')}`],
      ['复制选中文字', key(mac() ? '⌘ C' : 'Ctrl C')]
    ];
    if (state.tool !== 'native') shortcuts.push(['打开扩展面板', key(mac() ? '⌘ ⇧ X' : 'Ctrl Shift X')], ['打开命令面板', key(mac() ? '⌘ ⇧ P' : 'Ctrl Shift P')], ['关闭当前编辑器标签', key(mac() ? '⌘ W' : 'Ctrl W')]);
    return `<p class="stage-lead">先看记录类型，再看单元格中的值。表格只用于审阅，不会修改源文件。</p>
      ${image('gridiff-example.png', 'Gridiff 表格对比示例：绿色新增、红色删除，以及同一个单元格中的旧值和新值', 'Gridiff 实际界面示例；使用专门准备的演示表格。')}
      <div class="table-wrap"><table><thead><tr><th scope="col">看到的变化</th><th scope="col">怎样理解</th></tr></thead><tbody><tr><td class="added-text">+ 新增 · 绿色</td><td>新文件新增的记录。只显示新值。</td></tr><tr><td class="removed-text">− 删除 · 红色</td><td>旧文件中存在、新文件中移除的记录。只显示旧值。</td></tr><tr><td>~ 修改 · 旧 / 新</td><td>同一个单元格中，上方为旧值、下方为新值；变化部分分别标红、标绿。</td></tr><tr><td class="muted-text">颜色较淡的值</td><td>当前记录里未发生变化的字段，用于辅助理解上下文。</td></tr></tbody></table></div>
      <h3>用这几个控件缩小范围</h3><ul><li><strong>原表对照</strong>：按表格顺序一起看新增、删除和修改。<strong>变更清单</strong>：集中查看变化。</li><li><strong>仅看变动记录</strong>：隐藏没有变化的记录。<strong>仅看变动字段</strong>：隐藏整次比较中无变化的字段；新增行的有值字段也会保留。</li><li><strong>搜索框</strong>：搜索当前工作表的全部比较记录。分页不会让记录漏掉；浏览器 ${key(mac() ? '⌘ F' : 'Ctrl F')} 只能查当前已显示的页面，找表格内容请用 Gridiff 的搜索框。</li><li><strong>工作表</strong>下拉框：切换已经加载的 XLSX 工作表。</li></ul>
      <h3>格式、主键与工作表</h3><p>通常保留<strong>格式：自动</strong>和自动选择的主键（常见为 <strong>id</strong>）即可。主键用于认出同一条记录；重复或缺失时，先检查格式，再选唯一且非空的字段。按行号对齐适用于没有稳定标识的表格，但插入、删除可能使后续行错位。</p>
      <p>${state.tool === 'native' ? '仓库自带程序默认只读取 XLSX 第一张工作表，与 Mova 的主要导出范围一致。需要比较更多工作表时，查看下一步的“如何读取全部工作表”。' : '编辑器扩展默认读取 XLSX 的全部工作表。用于 Mova 表格时，可在编辑器设置中搜索 Gridiff，找到 Xlsx Sheets 并改成 first，然后点击“重新读取”。'}</p>
      <h3>调整明暗与配色</h3><p>${state.tool === 'native' ? '网页顶部的“明暗”默认跟随系统，也可手动选择浅色、深色；“配色”可选择默认、GitHub、Catppuccin、Solarized 或 Nord，下次打开会恢复你的选择。' : 'Gridiff 跟随编辑器的明暗和颜色主题。想换配色时，在编辑器命令面板搜索“颜色主题（Color Theme）”。'}</p>
      ${notice('公式只比较表格文件中已经保存的计算结果，Gridiff 不会重新计算公式。比较前请在表格编辑器中计算并保存。')}
      <h3>常用快捷键</h3><div class="table-wrap"><table><thead><tr><th scope="col">操作</th><th scope="col">按键</th></tr></thead><tbody>${shortcuts.map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`).join('')}</tbody></table></div><p class="helper">Gridiff 目前没有单独定义翻页、搜索等快捷键。上表使用系统${state.os === 'linux' ? '' : '、Fork'}和编辑器已有的操作；快捷键被改过时以本机菜单为准。</p>`;
  }

  function troubleshooting() {
    const standalone = state.tool === 'native';
    return `<p class="stage-lead">先找到对应现象，再检查一个最可能的原因。</p>
      <details><summary>新增显示成了删除，或旧值、新值反了</summary><p>所有 Gridiff 入口都按<strong>旧文件、新文件</strong>处理。Fork 自定义工具参数应为 <code>${standalone ? '$REMOTE $LOCAL' : '--wait --diff $REMOTE $LOCAL'}</code>。不要保留默认的 <code>$LOCAL $REMOTE</code>。内置 VS Code 仍使用内置配置。</p><p>修正后从 Fork 重新打开差异。“交换左右”可在当前页面临时反向审阅，不会修改 Fork 设置。</p></details>
      <details><summary>修改了表格，页面内容却没有更新</summary><p>先保存表格。${standalone ? '网页显示的是打开时的快照。“重新计算”只使用已有快照，不会重新读磁盘。请从 Fork 再打开一次外部差异。' : '点击 Gridiff 的“重新读取”，或从 Fork 重新打开差异。'}</p></details>
      <details><summary>文件无法打开，或提示 LFS 指针、没有对应程序</summary><p>${standalone ? '确认 Fork 的 File Path 指向当前仓库的顶层 gridiff 入口，仓库已更新，并下载了 Git LFS 的实际程序。请团队维护者协助执行 git lfs pull；本指南不会自动下载或修复权限。Windows ARM64、32 位没有对应原生版本。' : '确认编辑器安装位置和自定义工具路径正确。Cursor 需选择安装目录里的命令行入口，而不是随便选一个同名文件。再确认 Gridiff 已安装且启用。'}</p><p>遇到系统安全提示时，先核对程序来自团队策划仓库，再按公司要求处理；不需要关闭系统安全保护。</p></details>
      <details><summary>主键重复、主键缺失，或表格看起来错位</summary><p>先确认格式是普通表头、Mova 四行表头还是 Mova 竖表，再选唯一且非空的主键。仍无法按主键匹配时可用按行号对齐，但插入、删除会影响后续行的位置。</p></details>
      <details><summary>如何读取 XLSX 的全部工作表？</summary><p>${standalone ? '在 Fork 自定义工具的 Arguments 中使用下面这行，再重新打开比较。' : '在编辑器设置搜索 Gridiff，将 Xlsx Sheets 设为 all，再点击“重新读取”。需要指定表时选 named，并在 Xlsx Sheet Names 中填写完整表名。'}</p>${standalone ? copyBlock('all-sheets', 'Arguments · 比较全部工作表', '--sheets all $REMOTE $LOCAL') : ''}<p>工作表下拉框只能切换已经加载的表。公式只使用保存结果，不会重新计算。</p></details>
      <details><summary>Fork 一直等待，无法开始下一次比较</summary><p>${standalone ? '默认参数不会等待审阅结束。如果你主动加了 --wait，请在网页点击“结束比较”；只关标签会等到会话回收。' : '带 --wait 启动编辑器时，除了 Gridiff 表格，还需要关闭对应的原始文本差异标签；只关闭表格面板不会结束等待。'}</p></details>
      <details><summary>不支持的文件怎么办？</summary><p>Gridiff 用于两份同格式的 CSV 或 XLSX。${standalone ? '独立程序遇到其他扩展名、无扩展名或 CSV/XLSX 混合比较时，会在网页提示不支持，不会自动转交其他工具。需要看脚本、图片等文件时，请在 Fork 切换回适用的工具。' : '其他类型仍使用编辑器原始文本差异。CSV 表格也可以使用“文本对比”查看原文。'}</p></details>
      <details><summary>能用 Fork CLI 一键配置吗？</summary><p>本次核对的 Fork Command Line Tools v4 提供 open、status、commit、log 等打开视图的命令，没有公开的外部 Diff 配置命令。不能用 Git 的 diff.tool 设置代替 Fork 的界面配置。目前只需按本指南在 Fork 中设置一次。</p></details>
      <details><summary>网页能自动安装扩展、找到软件或检查路径吗？</summary><p>浏览器只报告系统信息，无法可靠判断本机是否安装了 Fork、VS Code 或 Cursor，也不能直接修改它们的配置。目录输入只用于拼接路径，成功复制不表示文件存在。请通过 Fork 的文件选择器核对实际位置。</p></details>
      <p class="helper">Fork 快捷键参考：${link('https://fork.dev/releasenotes', 'macOS 发布说明')} · ${link('https://github.com/fork-dev/TrackerWin/issues/333', 'Windows 官方问题记录')}。Windows 的列表布局和 Primary 操作未经本次实机核验。</p>`;
  }

  function linuxContent() {
    const editor = state.tool === 'cursor' ? 'Cursor' : 'VS Code';
    if (state.step === 1 && state.tool !== 'native') return install();
    if (state.step === 1 || state.step === 2 || state.step === 3) return `<p class="stage-lead">Fork 官方提供 macOS 和 Windows 版本，Linux 无法按本指南配置 Fork。</p>
      ${notice('你仍可独立使用 Gridiff。若实际使用的是 Windows 或 macOS，请先修改上方系统选项。', 'warning')}
      ${state.tool === 'native' ? `<p>仓库提供 Linux ARM64、x64 程序。更新策划库及 LFS 后，在终端中从 <code>design/gridiff/</code> 调用入口，依次指定旧文件、新文件。</p>${copyBlock('linux-command', '终端使用示例 · 请替换成实际文件', './gridiff "旧版本.csv" "新版本.csv"')}<p>程序会在默认浏览器打开差异。请确认文件管理器或终端中所用程序来自团队仓库。</p>` : `<p>在 ${editor} 安装扩展后，按 ${key('Ctrl Shift P')} 打开命令面板，运行 <strong>Gridiff: 比较两个文件…</strong>，依次选择旧文件、新文件。也可在编辑器的源代码管理中打开表格差异。</p>`}`;
    if (state.step === 4) return reading();
    return `<p class="stage-lead">Linux 使用独立比较，不需要配置 Fork。</p>
      <details><summary>旧、新方向反了怎么办？</summary><p>命令行按 <code>gridiff &lt;旧文件&gt; &lt;新文件&gt;</code> 传入；编辑器的“比较两个文件…”也依次选旧、新文件。“交换左右”可临时反向审阅。</p></details>
      <details><summary>文件改了，结果没更新怎么办？</summary><p>先保存文件。${state.tool === 'native' ? '在终端重新运行比较命令。“重新计算”只使用当前快照，不会重读磁盘。' : '点击“重新读取”，或再次运行“Gridiff: 比较两个文件…”。'}</p></details>
      <details><summary>缺少程序或提示 LFS 指针怎么办？</summary><p>仓库原生程序支持 Linux ARM64、x64。请团队维护者协助更新仓库和 Git LFS 的实际程序；不要选择 Windows 或 macOS 的程序。</p></details>
      <details><summary>如何读取全部 XLSX 工作表？</summary><p>${state.tool === 'native' ? '在终端使用下面的示例，替换成真实文件路径后运行。' : '在编辑器设置中搜索 Gridiff，将 Xlsx Sheets 改成 all，再点击“重新读取”。'}</p>${state.tool === 'native' ? copyBlock('all-sheets', '读取全部工作表 · 终端示例', './gridiff --sheets all "旧版本.xlsx" "新版本.xlsx"') : ''}</details>
      <details><summary>主键、格式或文件类型有问题怎么办？</summary><p>仅支持两份同格式的 CSV 或 XLSX。先确认表头格式，再选择唯一且非空的主键。按行号对齐可能因插入、删除而错位。公式只比较已保存的结果，不会重新计算。</p></details>`;
  }

  function updateRoot(touched = false) {
    const field = $('#project-root');
    if (!field) return;
    state.root = field.value;
    const value = nativePath();
    const invalid = Boolean(state.root.trim()) && !value;
    field.setAttribute('aria-invalid', String(invalid && touched));
    $('#root-help').textContent = invalid && touched ? (state.os === 'windows' ? '请输入带盘符的绝对路径，例如 D:\\work\\design；也可直接在 Fork 中选择文件。' : '请输入以 / 开头的绝对路径；也可直接在 Fork 中选择文件。') : '此输入只拼接路径，不检查磁盘。请在 Fork 中确认文件确实存在。';
    $('#root-help').classList.toggle('error-text', invalid && touched);
    $('#file-path').value = value;
    $('[data-copy="file-path"]').disabled = !value;
    $('#file-path-status').textContent = value ? '这只是拼接结果；推荐通过 File Path 右侧按钮选择真实文件。' : '请先选择文件，或填写上方本机仓库根目录。';
    $('#file-path-status').removeAttribute('data-state');
  }

  function render() {
    $('#os').value = state.os;
    $('#tool').value = state.tool;
    const detected = detectedSystem();
    $('#environment-note').textContent = (detected ? `浏览器报告系统为 ${systems[detected]}，可手动更改。` : '未能可靠识别桌面系统，请手动选择。') + '工具需自行选择；本页不会检测或安装本机软件。';
    $('#route-summary').textContent = `${systems[state.os] || '尚未选择系统'} / ${tools[state.tool]} / 第 ${state.step} 步`;
    $('#step-position').textContent = `${state.step} / ${titles.length}`;
    document.querySelectorAll('[data-step]').forEach(button => {
      if (Number(button.dataset.step) === state.step) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
    $('#previous').disabled = state.step === 1;
    $('#next').disabled = state.step === titles.length;
    $('.wordmark').href = '#' + new URLSearchParams({ os: state.os, tool: state.tool, step: '1' });
    const body = !state.os ? notice('请先在上方选择电脑系统，再继续查看对应步骤。') : state.os === 'linux' ? linuxContent() : [install, configure, firstComparison, reading, troubleshooting][state.step - 1]();
    $('#content').innerHTML = `<header class="stage-heading"><p class="eyebrow">STEP ${String(state.step).padStart(2, '0')} / ${String(titles.length).padStart(2, '0')}</p><h2 id="step-title">${titles[state.step - 1]}</h2></header>${body}`;
    if ($('#project-root')) {
      $('#project-root').addEventListener('input', () => updateRoot($('#project-root').dataset.touched === 'true'));
      $('#project-root').addEventListener('change', () => { $('#project-root').dataset.touched = 'true'; updateRoot(true); });
      updateRoot();
    }
    document.title = `${titles[state.step - 1]} · Gridiff 安装与使用指南`;
  }

  function navigate(patch, focus = false) {
    state = { ...state, ...patch };
    const hash = '#' + new URLSearchParams({ os: state.os, tool: state.tool, step: String(state.step) });
    try { history.replaceState(null, '', hash); } catch { location.hash = hash; }
    render();
    if (focus) { $('#content').focus({ preventScroll: true }); $('#content').scrollIntoView({ block: 'start' }); }
  }

  $('#os').addEventListener('change', event => navigate({ os: event.target.value }));
  $('.skip-link').addEventListener('click', event => { event.preventDefault(); $('#content').focus(); });
  $('#tool').addEventListener('change', event => navigate({ tool: event.target.value }));
  $('#step-nav').addEventListener('click', event => { const button = event.target.closest('[data-step]'); if (button) navigate({ step: Number(button.dataset.step) }, true); });
  $('#previous').addEventListener('click', () => { if (state.step > 1) navigate({ step: state.step - 1 }, true); });
  $('#next').addEventListener('click', () => { if (state.step < titles.length) navigate({ step: state.step + 1 }, true); });
  window.addEventListener('hashchange', () => { state = { ...state, ...route() }; render(); });
  $('#content').addEventListener('click', async event => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const field = document.getElementById(button.dataset.copy);
    const status = document.getElementById(button.dataset.copy + '-status');
    if (!field.value) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = '复制中…';
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(field.value);
      button.textContent = '已复制'; button.dataset.state = 'success';
      status.textContent = '已复制，可粘贴到对应输入框。'; status.dataset.state = 'success';
    } catch {
      field.focus({ preventScroll: true }); field.select();
      button.textContent = '再试复制'; button.dataset.state = 'error';
      status.textContent = `无法自动复制，内容已选中。请按 ${mac() ? '⌘ C' : 'Ctrl C'}，或使用系统复制菜单。`; status.dataset.state = 'error';
    } finally { button.disabled = false; button.removeAttribute('aria-busy'); }
  });
  render();
})();
