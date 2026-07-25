window.openEducacional = async function() {
  window.switchMultiverseRoom('educacionalRoomView', 'btnNavEducacional');
  
  await fetchDocumentaries();
  renderEducacionalView();
};

async function fetchDocumentaries() {
  try {
    const res = await fetch('/api/documentaries');
    if (res.ok) {
      const data = await res.json();
      AppState.documentaries = data.docs || [];
    }
  } catch(e) {
    console.warn('Erro ao carregar documentários:', e);
    AppState.documentaries = [];
  }
}

function openDocumentary(docId) {
  const doc = AppState.documentaries.find(d => d.id === docId);
  if (doc) {
    window.currentDocumentary = doc.script;
    window.currentDocFilename = doc.id + '.txt';
    // Se quiser que ele se lembre também de quais campanhas compõem para renderizar vídeo
    selectedCampaignsForDoc = doc.campaigns || [];
    renderDocumentaryResult();
  }
}

window.closeEducacional = function() {
  document.getElementById('educacionalRoomView').style.display = 'none';
  document.getElementById('multiverseWelcome').style.display = 'flex';
  if (window.highlightActiveRoom) window.highlightActiveRoom(null);
};

let selectedCampaignsForDoc = [];

function toggleCampaignSelection(campaignId) {
  const idx = selectedCampaignsForDoc.indexOf(campaignId);
  if (idx > -1) {
    selectedCampaignsForDoc.splice(idx, 1);
  } else {
    selectedCampaignsForDoc.push(campaignId);
  }
  renderEducacionalView();
}

async function handleGenerateDocumentary() {
  if (selectedCampaignsForDoc.length < 2) {
    alert('Selecione pelo menos 2 campanhas para agrupar em um Episódio Documental.');
    return;
  }
  
  const contentEl = document.getElementById('educacionalRoomContent');
  contentEl.innerHTML = `<div style="text-align: center; color: var(--ivTextSecondary); padding: 40px; width: 100%;">
    <div style="font-size: 2rem; margin-bottom: 16px;">🧠</div>
    Forjando o Roteiro Documental via Mistral... Aguarde.
  </div>`;
  
  const selectedData = selectedCampaignsForDoc.map(id => {
    return AppState.campaigns.find(c => c.id === id);
  }).filter(Boolean);
  
  try {
    const res = await fetch('/api/generate-documentary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaigns: selectedData
      })
    });
    
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Falha na geração');
    }
    
    const data = await res.json();
    window.currentDocumentary = data.script;
    window.currentDocFilename = data.filename;
    renderDocumentaryResult();
  } catch (error) {
    alert('Erro ao gerar documentário: ' + error.message);
    renderEducacionalView();
  }
}

function renderDocumentaryResult() {
  const contentEl = document.getElementById('educacionalRoomContent');
  
  contentEl.innerHTML = `
    <div style="display: flex; flex-direction: column; width: 100%; max-width: 1000px; margin: 0 auto; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.15); border-radius: 16px; overflow: hidden; height: 100%;">
      
      <div style="padding: 24px; border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.4);">
        <h3 style="margin: 0; color: #fff; font-family: var(--uiRounded);">Roteiro Documental Consolidado</h3>
        <div style="display: flex; gap: 12px; align-items: center;">
          <span style="color: #00d26a; font-size: 0.9rem; font-weight: bold; background: rgba(0, 210, 106, 0.1); padding: 6px 12px; border-radius: 6px; border: 1px solid rgba(0, 210, 106, 0.3);">
            💾 Salvo em: render/documentarios/${window.currentDocFilename}
          </span>
          <button class="actionBtn" onclick="renderEducacionalView()" style="border: 1px solid rgba(255,255,255,0.15); padding: 8px 16px;">VOLTAR À SELEÇÃO</button>
        </div>
      </div>
      
      <div style="flex: 1; overflow-y: auto; padding: 32px;">
        <pre style="white-space: pre-wrap; font-family: var(--readingFont, 'Inter', sans-serif); color: #e0e0e0; font-size: 1.1rem; line-height: 1.8; margin: 0;">${window.currentDocumentary}</pre>
      </div>
      
      <div style="padding: 24px; border-top: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.4); text-align: center;">
        <p style="color: var(--ivTextSecondary); margin: 0 0 16px 0; font-size: 0.95rem;">Clique abaixo para gerar o Áudio Neural (Edge-TTS) e juntar com as imagens (FFmpeg) em background.</p>
        
        <div style="margin-bottom: 24px; display: flex; flex-direction: column; align-items: center;">
          <label style="color: var(--ivTextSecondary); font-size: 0.85rem; display: block; margin-bottom: 8px;">Escolha a Voz do Locutor:</label>
          <select id="voiceSelector" style="background: rgba(0,0,0,0.5); color: #fff; border: 1px solid rgba(255,255,255,0.2); padding: 10px 16px; border-radius: 8px; outline: none; width: 100%; max-width: 320px; font-family: var(--uiText); font-size: 1rem; cursor: pointer;">
            <option value="pt-BR-AntonioNeural">👨 Antonio (Grave e Documental)</option>
            <option value="pt-BR-FranciscaNeural">👩 Francisca (Firme e Narrativa)</option>
            <option value="pt-BR-JulioNeural">👨 Julio (Jovem e Dinâmico)</option>
            <option value="pt-BR-ElzaNeural">👩 Elza (Acolhedora)</option>
            <option value="pt-BR-FabioNeural">👨 Fabio (Jornalístico)</option>
            <option value="pt-BR-ThalitaNeural">👩 Thalita (Suave e Clara)</option>
          </select>
        </div>

        <button id="btnRenderDoc" class="actionBtn" onclick="handleRenderVideo()" style="background: var(--brandGrad); color: #fff; border: none; font-weight: bold; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-size: 1.1rem; width: 100%; max-width: 400px;">🎬 RENDERIZAR VÍDEO FINAL (FFMPEG)</button>
        <div id="docMonitorContainer" style="display: none; width: 100%; max-width: 600px; background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 24px; margin-top: 16px; text-align: left;">
          <h4 style="color: #fff; margin: 0 0 16px 0; font-family: var(--uiRounded); display: flex; align-items: center; justify-content: space-between;">
            <span><span class="pulse-dot" style="display: inline-block; width: 10px; height: 10px; background: var(--cyan); border-radius: 50%; margin-right: 8px; box-shadow: 0 0 10px var(--cyan);"></span> PROCESSAMENTO VORTEX 9</span>
            <span id="docMonitorPercent" style="color: var(--cyan); font-size: 1.2rem;">0%</span>
          </h4>
          
          <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; margin-bottom: 24px; overflow: hidden;">
            <div id="docMonitorBar" style="height: 100%; width: 0%; background: var(--brandGrad); transition: width 0.5s ease;"></div>
          </div>
          
          <div style="display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px;">
            <div id="stepAudio" style="color: rgba(255,255,255,0.4); display: flex; align-items: center; gap: 12px; font-size: 0.95rem;"><span style="width: 20px;">1️⃣</span> Forja Neural de Áudio (Edge-TTS)</div>
            <div id="stepPrompts" style="color: rgba(255,255,255,0.4); display: flex; align-items: center; gap: 12px; font-size: 0.95rem;"><span style="width: 20px;">2️⃣</span> Engenharia de Prompts (Mistral AI)</div>
            <div id="stepImagen" style="color: rgba(255,255,255,0.4); display: flex; align-items: center; gap: 12px; font-size: 0.95rem;"><span style="width: 20px;">3️⃣</span> Fábrica Visual (Pollinations)</div>
            <div id="stepRender" style="color: rgba(255,255,255,0.4); display: flex; align-items: center; gap: 12px; font-size: 0.95rem;"><span style="width: 20px;">4️⃣</span> Montagem Final (FFmpeg)</div>
          </div>
          
          <div id="docMonitorLog" style="background: rgba(0,174,239,0.1); border-left: 3px solid var(--cyan); padding: 12px 16px; color: #fff; font-family: monospace; font-size: 0.85rem; border-radius: 0 8px 8px 0;">Iniciando os motores...</div>
        </div>
        
        <div id="docErrorContainer" style="display: none; width: 100%; max-width: 600px; background: rgba(255,68,68,0.1); border: 1px solid rgba(255,68,68,0.3); border-radius: 12px; padding: 16px; margin-top: 16px; text-align: left; border-left: 4px solid #ff4444;">
          <strong style="color: #ff4444; display: block; margin-bottom: 8px;">❌ FALHA NO SISTEMA</strong>
          <span id="docErrorMsg" style="color: #fff; font-size: 0.9rem;"></span>
        </div>
      </div>
    </div>
  `;
  
  if (window.activeDocJobId) {
    resumeDocPolling();
  }
}

function resumeDocPolling() {
  if (window.activeDocPollInterval) clearInterval(window.activeDocPollInterval);
  const btn = document.getElementById('btnRenderDoc');
  const monitor = document.getElementById('docMonitorContainer');
  const errorContainer = document.getElementById('docErrorContainer');
  const log = document.getElementById('docMonitorLog');
  const bar = document.getElementById('docMonitorBar');
  const percent = document.getElementById('docMonitorPercent');
  
  if (btn) btn.style.display = 'none';
  if (errorContainer) errorContainer.style.display = 'none';
  if (monitor) monitor.style.display = 'block';
  
  window.activeDocPollInterval = setInterval(async () => {
    try {
      const statusRes = await fetch(`/api/render-documentary/status?jobId=${window.activeDocJobId}`);
      if (!statusRes.ok) throw new Error('Falha ao checar status do motor');
      const currentJob = await statusRes.json();
      
      if (currentJob.status === 'running') {
        if (log) log.innerText = currentJob.detail;
        
        // Textos originais das etapas
        const stepLabels = {
          1: 'Forja Neural de Áudio (Edge-TTS)',
          2: 'Engenharia de Prompts (Mistral AI)',
          3: 'Fábrica Visual (Pollinations)',
          4: 'Montagem Final (FFmpeg)'
        };
        
        // Atualiza UI dos Steps
        [1,2,3,4].forEach(s => {
          const el = document.getElementById(s === 1 ? 'stepAudio' : s === 2 ? 'stepPrompts' : s === 3 ? 'stepImagen' : 'stepRender');
          if (!el) return;
          
          if (currentJob.step > s) {
            el.style.color = '#00d26a';
            el.innerHTML = `<span style="width: 20px;">✅</span> ${stepLabels[s]}`;
          } else if (currentJob.step === s) {
            el.style.color = '#fff';
            el.innerHTML = `<span style="width: 20px;">⏳</span> ${stepLabels[s]}`;
          } else {
            el.style.color = 'rgba(255,255,255,0.4)';
            el.innerHTML = `<span style="width: 20px;">${s}️⃣</span> ${stepLabels[s]}`;
          }
        });
        
        let p = (currentJob.step / 4) * 100;
        if (currentJob.step === 3 && currentJob.detail.includes('Imagens')) {
           const match = currentJob.detail.match(/Imagens (\d+) a (\d+) de (\d+)/);
           if (match) {
              const currentImg = parseInt(match[2]);
              const totalImg = parseInt(match[3]);
              const fraction = currentImg / totalImg;
              p = 50 + (fraction * 25); // Step 3 takes from 50% to 75%
           }
        }
        if (bar) bar.style.width = `${p}%`;
        if (percent) percent.innerText = `${Math.round(p)}%`;
        
      } else if (currentJob.status === 'done') {
        clearInterval(window.activeDocPollInterval);
        window.activeDocJobId = null;
        if (bar) bar.style.width = '100%';
        if (percent) percent.innerText = '100%';
        if (log) {
          log.style.background = 'rgba(0, 210, 106, 0.2)';
          log.style.borderLeftColor = '#00d26a';
          log.innerHTML = `✅ DOCUMENTÁRIO FINALIZADO!<br>Áudio: ${currentJob.result.audio}<br>Vídeo: ${currentJob.result.video}`;
        }
        if (btn) {
          btn.style.display = 'block';
          btn.innerText = '✨ RENDERIZAR NOVO PROJETO';
          btn.style.opacity = '1';
          btn.style.pointerEvents = 'auto';
        }
      } else if (currentJob.status === 'error') {
        clearInterval(window.activeDocPollInterval);
        window.activeDocJobId = null;
        throw new Error(currentJob.error || currentJob.detail || 'Erro no processo do servidor.');
      }
    } catch (err) {
      clearInterval(window.activeDocPollInterval);
      window.activeDocJobId = null;
      if (monitor) monitor.style.display = 'none';
      if (btn) {
        btn.style.display = 'block';
        btn.innerText = '❌ TENTAR NOVAMENTE';
        btn.style.background = '#ff4444';
        btn.style.opacity = '1';
        btn.style.pointerEvents = 'auto';
      }
      if (errorContainer) {
        errorContainer.style.display = 'block';
        document.getElementById('docErrorMsg').innerText = err.message;
      }
    }
  }, 2000);
}

async function handleRenderVideo() {
  const btn = document.getElementById('btnRenderDoc');
  const errorContainer = document.getElementById('docErrorContainer');
  
  if (btn) btn.style.display = 'none';
  if (errorContainer) errorContainer.style.display = 'none';
  
  const selectedData = selectedCampaignsForDoc.map(id => {
    return AppState.campaigns.find(c => c.id === id || String(c.number) === String(id) || String(c.number).padStart(2,'0') === String(id));
  }).filter(Boolean);
  
  const voiceId = document.getElementById('voiceSelector').value || 'pt-BR-AntonioNeural';
  
  try {
    const res = await fetch('/api/render-documentary/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        script: window.currentDocumentary,
        docFilename: window.currentDocFilename,
        campaigns: selectedData,
        voiceId: voiceId
      })
    });
    
    if (!res.ok) {
        const errTxt = await res.text();
        throw new Error(errTxt);
    }
    const job = await res.json();
    
    window.activeDocJobId = job.jobId;
    resumeDocPolling();
    
  } catch (error) {   
    if (btn) {
      btn.style.display = 'block';
      btn.style.background = '#ff4444';
      btn.innerText = '❌ TENTAR NOVAMENTE';
    }
    if (errorContainer) {
      errorContainer.style.display = 'block';
      document.getElementById('docErrorMsg').innerText = error.message;
    }
  }
}

function renderEducacionalView() {
  const contentEl = document.getElementById('educacionalRoomContent');
  const validCampaigns = AppState.campaigns.filter(c => c.scenes && c.scenes.length > 0);
  
  let html = `
    <div style="display: flex; flex-direction: column; width: 100%; height: 100%; padding: 0 24px; overflow-y: auto;">
  `;
  
  // BIBLIOTECA DE DOCUMENTÁRIOS
  if (AppState.documentaries && AppState.documentaries.length > 0) {
    html += `
      <div style="margin-bottom: 32px;">
        <h3 style="color: #fff; font-family: var(--uiRounded); margin: 0 0 16px 0; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px;">📚 Seus Documentários Salvos</h3>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px;">
    `;
    
    AppState.documentaries.forEach(doc => {
       const dateStr = new Date(doc.createdAt).toLocaleString('pt-BR', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'});
       const cList = doc.campaignTitles ? doc.campaignTitles.join(' + ') : `Minisséries: ${doc.campaigns.join(', ')}`;
       const statusBadge = doc.videoPath ? `<span style="background: #00d26a; color: #000; padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 0.75rem;">🎬 Vídeo Pronto</span>` : 
                           doc.audioPath ? `<span style="background: var(--brandGrad); color: #fff; padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 0.75rem;">🎙️ Áudio Pronto</span>` : 
                                           `<span style="background: rgba(255,255,255,0.1); color: #ccc; padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 0.75rem;">📝 Roteiro</span>`;
       html += `
         <div onclick="openDocumentary('${doc.id}')" style="background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); border-radius: 12px; padding: 16px; cursor: pointer; transition: all 0.2s ease;">
           <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
             <span style="color: var(--ivTextSecondary); font-size: 0.8rem;">${dateStr}</span>
             ${statusBadge}
           </div>
           <h4 style="color: #fff; margin: 0 0 8px 0; font-family: var(--uiText); font-size: 1rem; line-height: 1.4;">${cList}</h4>
         </div>
       `;
    });
    
    html += `
        </div>
      </div>
    `;
  }
  
  html += `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
        <h3 style="color: #fff; font-family: var(--uiRounded); margin: 0;">🔨 Criar Novo Documentário</h3>
        <button class="actionBtn" onclick="handleGenerateDocumentary()" style="background: ${selectedCampaignsForDoc.length >= 2 ? 'var(--brandGrad)' : 'rgba(255,255,255,0.1)'}; color: ${selectedCampaignsForDoc.length >= 2 ? '#fff' : 'rgba(255,255,255,0.4)'}; border: none; font-weight: bold; padding: 12px 24px; border-radius: 8px; cursor: ${selectedCampaignsForDoc.length >= 2 ? 'pointer' : 'not-allowed'}; transition: all 0.3s ease;">
          🧠 GERAR ROTEIRO DOCUMENTAL
        </button>
      </div>
      <p style="color: var(--ivTextSecondary); margin-top: -16px; margin-bottom: 24px;">Selecione de 2 a 5 minisséries afins para agrupá-las.</p>
      
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; flex: 1; padding-bottom: 32px;">
  `;
  
  if (validCampaigns.length === 0) {
    html += `<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: rgba(255,255,255,0.3);">Nenhuma minissérie completa encontrada na Biblioteca.</div>`;
  } else {
    validCampaigns.forEach(c => {
      const isSelected = selectedCampaignsForDoc.includes(c.id);
      const numStr = String(c.number).padStart(2, '0');
      
      let topicTitle = c.title || 'Sem título';
      if (typeof c.topic === 'string') topicTitle = c.topic;
      else if (c.topic && c.topic.title) topicTitle = c.topic.title;
      
      html += `
        <div onclick="toggleCampaignSelection('${c.id}')" style="background: rgba(255,255,255,0.03); border: 2px solid ${isSelected ? 'var(--cyan)' : 'rgba(255,255,255,0.1)'}; border-radius: 12px; padding: 16px; cursor: pointer; transition: all 0.2s ease; position: relative; display: flex; flex-direction: column;">
          
          ${isSelected ? `<div style="position: absolute; top: -10px; right: -10px; background: var(--cyan); color: #000; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 14px; box-shadow: 0 4px 10px rgba(0,0,0,0.5);">✓</div>` : ''}
          
          <span style="color: var(--ivTextSecondary); font-size: 0.8rem; font-weight: bold; margin-bottom: 8px;">MINISSÉRIE ${numStr}</span>
          <h4 style="color: #fff; margin: 0 0 12px 0; font-family: var(--uiText); font-size: 1.1rem; line-height: 1.4;">${topicTitle}</h4>
          
          <div style="display: flex; gap: 8px; margin-top: auto;">
            <span style="background: rgba(255,255,255,0.1); padding: 4px 8px; border-radius: 4px; font-size: 0.75rem; color: #ccc;">${c.scenes?.length || 5} Cenas</span>
            ${c.socialCaption ? `<span style="background: rgba(255,255,255,0.1); padding: 4px 8px; border-radius: 4px; font-size: 0.75rem; color: #ccc;">Tem Social</span>` : ''}
          </div>
        </div>
      `;
    });
  }
  
  html += `
      </div>
    </div>
  `;
  
  contentEl.innerHTML = html;
}
