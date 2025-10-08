import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    generateQuietPrompt,
    chat_metadata,
    substituteParams,
    saveChatDebounced,
    chat,
} from '../../../../script.js';
import { getContext } from '../../../extensions.js';

// --- MODULE CONSTANTS ---
const EXTENSION_NAME = 'task_breakdown_manager';
const EXTENSION_FOLDER_PATH = `scripts/extensions/third-party/${EXTENSION_NAME}`;
const PANEL_ID = 'task_manager_panel';
const ICON_ID = 'task-manager-header-icon';
const BACKDROP_ID = 'task-manager-backdrop';
const DEFAULT_PERSPECTIVE = '从{{user}}的第三人称视角出发（使用“他/她”）。';
const DEFAULT_INJECTION_POSITION = 'before_chat';

// --- STATE ---
let tasks = [];
let autoCompleteDebounce = null;
let rollbackDebounce = null;
const DEFAULT_BREAKDOWN_PROMPT = '将目标分解为一系列具体的、可执行的步骤。你可以使用缩进（在行首添加两个空格）来表示子任务/分支。每个节点自成一行，并以连字符“-”开头。对于选择节点，请用“[选择]”作为前缀。例如:\n- 主要任务\n  - [选择] 走哪条路？\n    - 走左边的路\n    - 走右边的路';

// --- PANEL VISIBILITY ---
function showPanel() { $(`#${BACKDROP_ID}, #${PANEL_ID}`).removeClass('hidden'); }
function hidePanel() { $(`#${BACKDROP_ID}, #${PANEL_ID}`).addClass('hidden'); }
function togglePanel() { $(`#${BACKDROP_ID}, #${PANEL_ID}`).toggleClass('hidden'); }

// --- TREE TRAVERSAL & MANIPULATION HELPERS ---
function* traverseTasks(tasks) { for (const task of tasks) { yield task; if (task.children) { yield* traverseTasks(task.children); } } }
function findTaskById(tasks, id) { for (const task of traverseTasks(tasks)) { if (task.id === id) return task; } return null; }
function findParent(tasks, childId) { for (const task of traverseTasks(tasks)) { if (task.children && task.children.some(child => child.id === childId)) return task; } return null; }

// --- Rollback Function for the Tree ---
function checkForRollback() {
    let rolledBack = false;
    for (const task of traverseTasks(tasks)) {
        if (task.completed && task.completedByMessageIndex !== undefined && task.completedByMessageIndex >= chat.length) {
            task.completed = false; delete task.completedByMessageIndex; rolledBack = true;
        }
        if (task.type === 'choice' && task.activeBranch) {
            const activeBranch = task.children.find(child => child.id === task.activeBranch);
            // If the active branch itself has been rolled back, un-set the choice
            if (!activeBranch || !activeBranch.completed) { 
                task.activeBranch = null; 
                task.completed = false; // The choice itself is no longer considered "completed"
                rolledBack = true; 
            }
        }
    }
    if (rolledBack) { toastr.info('检测到聊天记录变更，已自动回退相关节点状态。'); saveState(); renderTaskList(); }
}

// --- STATE MANAGEMENT ---
function saveState() {
    const context = getContext();
    const charIndex = context.characterId;
    if (!context.chatId || (charIndex === undefined || charIndex === null)) return;
    const charUniqueId = context.characters[charIndex]?.avatar;
    if (!charUniqueId) return;
    if (!chat_metadata[EXTENSION_NAME]) chat_metadata[EXTENSION_NAME] = { characters: {} };
    if (!chat_metadata[EXTENSION_NAME].characters) chat_metadata[EXTENSION_NAME].characters = {};
    chat_metadata[EXTENSION_NAME].characters[charUniqueId] = {
        tasks, mainObjective: $('#main_objective').val(), breakdownPrompt: $('#breakdown_prompt').val(), perspective: $('#perspective_select').val(),
        customPerspective: $('#custom_perspective_prompt').val(), injectionPosition: $('#injection_position_select').val(), autoComplete: $('#auto_complete_toggle').is(':checked'),
    };
    saveChatDebounced();
}

function loadState() {
    const context = getContext();
    const charIndex = context.characterId;
    if (!context.chatId || (charIndex === undefined || charIndex === null) || !context.characters[charIndex]) { tasks = []; }
    else { const charUniqueId = context.characters[charIndex].avatar; const extensionState = chat_metadata[EXTENSION_NAME]; tasks = extensionState?.characters?.[charUniqueId]?.tasks || []; }
    checkForRollback();
    const charStateForUI = chat_metadata[EXTENSION_NAME]?.characters?.[context.characters[charIndex]?.avatar];
    if (charStateForUI) {
        $('#main_objective').val(charStateForUI.mainObjective || ''); $('#breakdown_prompt').val(charStateForUI.breakdownPrompt || DEFAULT_BREAKDOWN_PROMPT);
        $('#perspective_select').val(charStateForUI.perspective || DEFAULT_PERSPECTIVE); $('#custom_perspective_prompt').val(charStateForUI.customPerspective || '');
        $('#injection_position_select').val(charStateForUI.injectionPosition || DEFAULT_INJECTION_POSITION); $('#auto_complete_toggle').prop('checked', charStateForUI.autoComplete || false);
    } else {
        $('#main_objective').val(''); $('#breakdown_prompt').val(DEFAULT_BREAKDOWN_PROMPT); $('#perspective_select').val(DEFAULT_PERSPECTIVE);
        $('#custom_perspective_prompt').val(''); $('#injection_position_select').val(DEFAULT_INJECTION_POSITION); $('#auto_complete_toggle').prop('checked', false);
    }
    toggleCustomPerspectiveInput();
    renderTaskList();
}

function toggleCustomPerspectiveInput() { if ($('#perspective_select').val() === 'custom') $('#custom_perspective_prompt').show(); else $('#custom_perspective_prompt').hide(); }

// --- UI LOGIC ---
function getActivePath() {
    const path = [];
    const visited = new Set();

    function findNextActiveNode(nodeList) {
        for (const node of nodeList) {
            if (visited.has(node.id)) {
                console.warn('[故事树] 检测到循环路径，已中断。', path);
                return { found: true, terminal: true }; // Prevent infinite loops
            }

            if (!node.completed) {
                path.push(node);
                return { found: true, terminal: false }; // Found an active, uncompleted node
            }
            
            visited.add(node.id);
            path.push(node);

            let result = { found: false, terminal: false };

            if (node.jumpToId) {
                const targetNode = findTaskById(tasks, node.jumpToId);
                if (targetNode) result = findNextActiveNode([targetNode]);
            } else if (node.type === 'choice') {
                if (node.activeBranch) {
                    const chosenBranch = node.children.find(c => c.id === node.activeBranch);
                    if (chosenBranch) result = findNextActiveNode([chosenBranch]);
                }
            } else if (node.children && node.children.length > 0) {
                result = findNextActiveNode(node.children);
            }

            if (result.found) return result;
            
            path.pop();
            visited.delete(node.id);
        }
        return { found: false, terminal: true };
    }

    const finalResult = findNextActiveNode(tasks);
    
    if (!finalResult.found && finalResult.terminal) {
        return [];
    }

    return path;
}

function refreshActiveTaskUI() {
    const activePath = getActivePath();
    $('.task-item').removeClass('active');

    if (activePath.length > 0) {
        const activeNode = activePath[activePath.length - 1];
        $(`[data-task-id="${activeNode.id}"]`).addClass('active');

        if (activeNode.completed && !activeNode.jumpToId && !(activeNode.children && activeNode.children.length > 0)) {
             $('#active_task_info').html('<small>所有故事线已完成！</small>');
        } else if (activeNode.type === 'choice' && !activeNode.completed) {
            $('#active_task_info').html(`<strong>当前抉择:</strong> ${activeNode.description}`);
        } else if (activeNode.type === 'task' && !activeNode.completed){
            const perspectiveText = activeNode.perspective ? `<br><small><b>视角:</b> ${activeNode.perspective}</small>` : '';
            $('#active_task_info').html(`<strong>当前任务:</strong> ${activeNode.description}${perspectiveText}`);
        }
    } else {
        $('#active_task_info').html('<small>所有故事线已完成！</small>');
    }
}


function renderTaskNode(task) {
    const hasChildren = task.children && task.children.length > 0;
    const parentChoice = findParent(tasks, task.id);
    const isDisabled = parentChoice && parentChoice.type === 'choice' && parentChoice.activeBranch && parentChoice.activeBranch !== task.id;

    let iconHtml, controlsHtml;
    const jumpTargetHtml = task.jumpToId ? `<div class="jump-indicator" title="完成后跳转到 ${task.jumpToId}"><i class="fa-solid fa-share-from-square"></i> ${task.jumpToId.toString().slice(-4)}</div>` : '';

    if (task.type === 'choice') {
        iconHtml = '<i class="fa-solid fa-diamond"></i>';
        controlsHtml = '<i class="fa-solid fa-plus add-branch-button task-action-button" title="添加分支"></i>';
    } else {
        iconHtml = `<input type="checkbox" class="task-checkbox" ${task.completed ? 'checked' : ''}>`;
        controlsHtml = `
            <i class="fa-solid fa-share-from-square set-jump-button task-action-button" title="设置完成后跳转"></i>
            <i class="fa-solid fa-plus add-child-task-button task-action-button" title="添加子任务"></i>
            <i class="fa-solid fa-diamond add-child-choice-button task-action-button" title="添加子选择"></i>
        `;
    }
    const nodeHtml = $(`
        <div class="task-node" data-task-id="${task.id}">
            <div class="task-item type-${task.type} ${isDisabled ? 'disabled' : ''} ${task.completed ? 'completed' : ''}">
                <div class="task-item-main">
                    <span class="task-node-icon">${iconHtml}</span>
                    <textarea class="task-description text_pole" rows="1" placeholder="${task.type === 'choice' ? '抉择点描述...' : '故事节点描述...'}">${task.description}</textarea>
                    ${jumpTargetHtml}
                </div>
                <div class="task-item-controls">
                    ${controlsHtml}
                    <i class="fa-solid fa-copy copy-id-button task-action-button" title="复制节点ID"></i>
                    <i class="fa-solid fa-trash-can delete-task-button task-action-button" title="删除节点"></i>
                </div>
            </div>
            <div class="task-children-container"></div>
        </div>
    `);
    if (task.type === 'task') {
        nodeHtml.find('.task-checkbox').on('change', function() {
            task.completed = this.checked; if (this.checked && parentChoice && parentChoice.type === 'choice' && !parentChoice.activeBranch) { parentChoice.activeBranch = task.id; parentChoice.completed = true; }
            saveState(); renderTaskList();
        });
        nodeHtml.find('.add-child-task-button').on('click', () => addChildNode(task.id, 'task'));
        nodeHtml.find('.add-child-choice-button').on('click', () => addChildNode(task.id, 'choice'));
        
        nodeHtml.find('.set-jump-button').on('click', () => {
            const targetId = prompt('输入目标节点的ID (留空则清除跳转):', task.jumpToId || '');
            if (targetId === null) return;
            const targetNode = findTaskById(tasks, Number(targetId));
            if (targetId.trim() !== '' && !targetNode) { toastr.error('找不到该ID对应的节点。'); return; }
            task.jumpToId = targetId.trim() === '' ? null : Number(targetId);
            saveState(); renderTaskList();
        });
    } else {
        nodeHtml.find('.add-branch-button').on('click', () => addChildNode(task.id, 'task'));
    }
    nodeHtml.find('.delete-task-button').on('click', () => { deleteTask(task.id); });
    nodeHtml.find('.copy-id-button').on('click', () => { navigator.clipboard.writeText(task.id); toastr.success(`节点ID "${task.id}" 已复制到剪贴板。`); });
    const textarea = nodeHtml.find('.task-description');
    textarea.on('input', function() { this.style.height = 'auto'; this.style.height = (this.scrollHeight) + 'px'; }).on('blur', function() {
        const newDescription = $(this).val(); if (task.description !== newDescription) { task.description = newDescription; saveState(); refreshActiveTaskUI(); }
    });
    setTimeout(() => textarea.trigger('input'), 0);
    if (hasChildren) { const childrenContainer = nodeHtml.find('.task-children-container'); task.children.forEach(childNode => { childrenContainer.append(renderTaskNode(childNode)); }); }
    return nodeHtml;
}


function renderTaskList() {
    const container = $('#task_list_container');
    container.empty();
    if (tasks.length === 0) { container.html('<p style="padding-left: 5px;"><i>点击上方按钮开始你的故事...</i></p>'); }
    else { tasks.forEach(task => container.append(renderTaskNode(task))); }
    refreshActiveTaskUI();
}

// --- TASK LOGIC (REFINED) ---
function createNewNode(description, type) {
    const newNode = { id: Date.now() + Math.random(), type, description, completed: false, children: [], perspective: $('#perspective_select').val(), jumpToId: null };
    if (type === 'choice') newNode.activeBranch = null;
    return newNode;
}

function addNewNode(description, type = 'task') {
    const newNode = createNewNode(description, type);
    tasks.push(newNode);
    saveState(); renderTaskList();
}

function addChildNode(parentId, type) {
    const parentNode = findTaskById(tasks, parentId);
    if (!parentNode) { toastr.error('无法找到父节点！'); return; }
    const description = type === 'task' ? '新故事节点' : '新选择节点';
    const newNode = createNewNode(description, type);
    if (!parentNode.children) parentNode.children = [];
    parentNode.children.push(newNode);
    saveState(); renderTaskList();
}

function deleteTask(id) { const parent = findParent(tasks, id); if (parent) { parent.children = parent.children.filter(c => c.id !== id); } else { tasks = tasks.filter(t => t.id !== id); } saveState(); renderTaskList(); }

// --- AI GENERATION ---
async function handleGenerateTasksClick() {
    const button = $('#generate_tasks_button');
    const objective = $('#main_objective').val().trim();
    const instruction = $('#breakdown_prompt').val().trim();
    if (!objective || !instruction) { toastr.warning('主目标和AI处理指令均不能为空！'); return; }
    const context = getContext();
    const character = context.characters[context.characterId];
    if (!character) { toastr.error('错误：无法找到当前角色数据。'); return; }
    button.prop('disabled', true).text('生成中...');
    const prompt = `# 核心目标:\n${objective}\n\n# 指令:\n${instruction}`;
    try {
        const rawResponse = await generateQuietPrompt(substituteParams(prompt), true, true);
        const lines = rawResponse.split('\n');
        const getIndentation = line => line.match(/^\s*/)[0].length;
        const parentStack = []; const newNodes = [];
        lines.forEach(line => {
            if (!line.trim().startsWith('-')) return;
            const indent = getIndentation(line);
            let description = line.trim().substring(1).trim();
            let type = 'task';
            if (description.toLowerCase().startsWith('[选择]')) { type = 'choice'; description = description.substring(6).trim(); }
            if (!description) return;
            const node = createNewNode(description, type); node._indent = indent;
            if (indent === 0) { newNodes.push(node); parentStack.length = 0; parentStack.push(node); }
            else {
                while (parentStack.length > 0 && parentStack[parentStack.length - 1]._indent >= indent) { parentStack.pop(); }
                const parent = parentStack.length > 0 ? parentStack[parentStack.length - 1] : null;
                if (parent) { if (!parent.children) parent.children = []; parent.children.push(node); } else { newNodes.push(node); }
                parentStack.push(node);
            }
        });
        if (newNodes.length > 0) { tasks = tasks.concat(newNodes); toastr.success(`成功生成 ${newNodes.length} 个新节点！`); }
        else { toastr.info('在AI的回复中没有找到可添加的新节点。'); }
        saveState(); renderTaskList();
    } catch (error) { toastr.error(`生成失败: ${error.message}`); }
    finally { button.prop('disabled', false).text('AI生成任务'); }
}

// --- AUTO-COMPLETION & INJECTION ---
function onChatCompletionPromptReady(eventData) {
    const activePath = getActivePath();
    if (activePath.length === 0) return;
    const activeNode = activePath[activePath.length-1];
    if (activeNode && !activeNode.completed) {
        let promptText;
        if (activeNode.type === 'task') {
            promptText = `[当前任务: ${activeNode.description}]`;
        } else {
            promptText = `[当前抉择: ${activeNode.description}]`;
        }
        eventData.chat.splice(eventData.chat.findIndex(m => m.role !== 'system'), 0, { role: 'system', content: promptText });
    }
}

// BUG-FIX: Major rewrite to handle choice nodes
async function handleAutoCompletionCheck() {
    if (!$('#auto_complete_toggle').is(':checked') || chat.length < 2) return;
    
    const activePath = getActivePath();
    if (activePath.length === 0) return;
    const activeNode = activePath[activePath.length-1];
    if (!activeNode || activeNode.completed) return;

    const lastUserMsg = chat[chat.length - 2].mes;
    const lastAiMsg = chat[chat.length - 1].mes;

    try {
        if (activeNode.type === 'task') {
            const prompt = `# 对话上下文:\nUser: ${lastUserMsg}\nAI: ${lastAiMsg}\n\n# 判断任务是否完成:\n${activeNode.description}\n\n# 回答:\n仅回答 "yes" 或 "no"`;
            const result = await generateQuietPrompt(prompt, true, true);
            if (result.trim().toLowerCase().includes('yes')) {
                activeNode.completed = true;
                activeNode.completedByMessageIndex = chat.length - 1;
                const parentChoice = findParent(tasks, activeNode.id);
                if (parentChoice && parentChoice.type === 'choice' && !parentChoice.activeBranch) {
                    parentChoice.activeBranch = activeNode.id;
                    parentChoice.completed = true;
                }
                toastr.success(`任务自动完成: "${activeNode.description}"`);
                saveState();
                renderTaskList();
            }
        } else if (activeNode.type === 'choice' && activeNode.children && activeNode.children.length > 0) {
            const branchesText = activeNode.children.map((child, index) => `${index + 1}. ${child.description}`).join('\n');
            const prompt = `# 对话上下文:\nUser: ${lastUserMsg}\nAI: ${lastAiMsg}\n\n# 当前抉择:\n${activeNode.description}\n\n# 可用分支:\n${branchesText}\n\n# 指令:\n根据对话上下文，AI的回复完成了哪个分支？请只回答分支对应的数字。如果没有完成任何分支，请回答 "0"。`;
            const result = await generateQuietPrompt(prompt, true, true);
            const choiceIndex = parseInt(result.trim(), 10) - 1;

            if (!isNaN(choiceIndex) && choiceIndex >= 0 && choiceIndex < activeNode.children.length) {
                const completedBranch = activeNode.children[choiceIndex];
                completedBranch.completed = true;
                completedBranch.completedByMessageIndex = chat.length - 1;
                
                activeNode.completed = true; // Mark the choice itself as resolved
                activeNode.activeBranch = completedBranch.id;

                toastr.success(`分支选择: "${completedBranch.description}"`);
                saveState();
                renderTaskList();
            }
        }
    } catch (error) {
        console.error('[故事树] 自动完成检查失败:', error);
        toastr.warning('自动完成检查时出错。');
    }
}


// --- IMPORT/EXPORT ---
function handleExportTasks() {
    const cleanTasks = tasks.map(function cleaner(task) {
        const cleanTask = { id: task.id, type: task.type, description: task.description, completed: task.completed, perspective: task.perspective, activeBranch: task.activeBranch, jumpToId: task.jumpToId };
if (task.children && task.children.length > 0) { cleanTask.children = task.children.map(cleaner); } return cleanTask;
    });
    const dataToExport = { mainObjective: $('#main_objective').val(), tasks: cleanTasks };
    const blob = new Blob([JSON.stringify(dataToExport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `SillyTavern_StoryTree_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    toastr.success('故事树已导出！');
}
function handleImportTasks() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
    input.onchange = (event) => {
        const file = event.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (data && Array.isArray(data.tasks)) {
                    const importedTasks = data.tasks.map(function hydrator(t) {
                        const node = { id: t.id || Date.now() + Math.random(), type: t.type || 'task', description: t.description, completed: t.completed || false, perspective: t.perspective || '', children: [], activeBranch: t.activeBranch || null, jumpToId: t.jumpToId || null };
                        if (t.children && Array.isArray(t.children)) { node.children = t.children.map(hydrator); } return node;
                    });
                    tasks = tasks.concat(importedTasks);
                    if (data.mainObjective) { $('#main_objective').val(data.mainObjective); }
                    saveState(); renderTaskList(); toastr.success('故事树已成功导入！');
                } else { toastr.error('文件格式不正确。'); }
            } catch (error) { toastr.error(`导入失败: ${error.message}`); }
        };
        reader.readAsText(file);
    };
    input.click();
}

// --- Mutation Observer ---
function setupMutationObserver() {
    const targetNode = document.getElementById('chat');
    if (!targetNode) { console.error('[任务管理器] 无法找到聊天容器 (#chat)。'); return; }
    const observer = new MutationObserver((mutationsList) => {
        for (const mutation of mutationsList) {
            if (mutation.addedNodes.length > 0) {
                const addedIsMessage = Array.from(mutation.addedNodes).some(node => node.classList?.contains('mes'));
                if (addedIsMessage) { clearTimeout(autoCompleteDebounce); autoCompleteDebounce = setTimeout(() => { if (chat.length > 0 && !chat[chat.length - 1].is_user) { handleAutoCompletionCheck(); } }, 200); }
            }
            if (mutation.removedNodes.length > 0) {
                const removedIsMessage = Array.from(mutation.removedNodes).some(node => node.classList?.contains('mes'));
                if (removedIsMessage) { clearTimeout(rollbackDebounce); rollbackDebounce = setTimeout(checkForRollback, 100); }
            }
        }
    });
    observer.observe(targetNode, { childList: true, subtree: true });
}

// --- INITIALIZATION ---
jQuery(async () => {
    try {
        const iconHtml = `<div id="${ICON_ID}" class="drawer-icon interactable openIcon" title="故事树管理器"><i class="fa-solid fa-fw fa-diagram-project"></i></div>`;
        const anchorButton = $('#extensions-settings-button');
        if (anchorButton.length > 0) { anchorButton.after(iconHtml); } else { console.error('[任务管理器] 致命错误：无法找到注入锚点。'); return; }
        const backdropHtml = `<div id="${BACKDROP_ID}" class="hidden"></div>`;
        const panelHtml = await $.get(`${EXTENSION_FOLDER_PATH}/index.html`);
        $('body').append(backdropHtml).append(panelHtml);

        $(`#${ICON_ID}`).on('click', togglePanel);
        $('.panel-close-button').on('click', hidePanel);
        $(`#${BACKDROP_ID}`).on('click', hidePanel);
        $(document).on('keydown', (event) => { if (event.key === 'Escape') { hidePanel(); } });

        $('#generate_tasks_button').on('click', handleGenerateTasksClick);
        $('#add_task_button').on('click', () => addNewNode('新故事节点', 'task'));
        $('#add_choice_button').on('click', () => addNewNode('新选择节点', 'choice'));
        $('#export_tasks_button').on('click', handleExportTasks);
        $('#import_tasks_button').on('click', handleImportTasks);

        $('#main_objective, #breakdown_prompt, #custom_perspective_prompt, #perspective_select, #injection_position_select, #auto_complete_toggle').on('change', saveState);
        $('#perspective_select').on('change', toggleCustomPerspectiveInput);
        
        eventSource.on(event_types.CHAT_CHANGED, loadState);
        eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
        
        setupMutationObserver();
        loadState();
        console.log('[任务管理器] V16.2.0 (Choice Auto-Completion Fix) 已成功初始化。');
    } catch (error) {
        console.error('[任务管理器] 插件初始化失败:', error);
    }
});