"use client";

import { useState, useEffect, useCallback } from "react";
import {
  FiMenu,
  FiChevronRight,
  FiPlus,
  FiLock,
  FiAlertCircle,
  FiRefreshCw,
} from "react-icons/fi";
import Sidebar from "./Sidebar";
import ChatWindow from "./ChatWindow";
import ComputerPanel from "./ComputerPanel";
import Marketplace from "./Marketplace";
import AuditPanel from "./AuditPanel";
import AppSettingsDrawer from "./AppSettingsDrawer";
import AgentStatePanel from "./AgentStatePanel";
import Overview from "./Overview";
import CreateDotDialog from "./CreateDotDialog";
import ContactPanel from "./ContactPanel";
import TeamPanel from "./TeamPanel";
import useLiquidGlass from "../lib/useLiquidGlass";
import { applyAppearance } from "../lib/appearance";
import {
  fetchBots,
  fetchModels,
  fetchChatHistory,
  fetchSettings,
  createBot,
  updateBot,
} from "../lib/api";

const tabNames = {
  overview: "Inicio",
  chat: "Conversación",
  computer: "Ordenador",
  marketplace: "Conectores",
  audit: "Actividad",
  memory: "Memoria",
  routines: "Rutinas",
  contact: "Llamadas y WhatsApp",
  team: "Equipo de Dots",
};
export default function Dashboard({ onLogout }) {
  const glassRef = useLiquidGlass();
  const [bots, setBots] = useState([]);
  const [models, setModels] = useState([]);
  const [activeBotId, setActiveBotId] = useState("");
  const [activeTab, setActiveTab] = useState("overview");
  const [messages, setMessages] = useState([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [defaultModel, setDefaultModel] = useState(
    "nvidia/nemotron-3-super-120b-a12b",
  );
  const [providerConfigured, setProviderConfigured] = useState(false);
  const [userName, setUserName] = useState("Tú");
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(null);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const closeSettings = useCallback(() => setIsSettingsOpen(false), []);
  const closeCreate = useCallback(() => setCreateOpen(false), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [botData, modelData, settingsData] = await Promise.all([
        fetchBots(),
        fetchModels(),
        fetchSettings(),
      ]);
      if (!settingsData)
        throw new Error("No se pudo cargar la configuración de tu espacio.");
      setBots(botData);
      setModels(modelData);
      setDefaultModel(settingsData.default_model);
      setProviderConfigured(Boolean(settingsData.model_api_key_configured));
      applyAppearance(settingsData, true);
      setActiveBotId((id) => id || botData[0]?.id || "");
    } catch (failure) {
      setError(failure.message || "No se pudo cargar tu espacio.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setUserName(localStorage.getItem("open_dots_user_name") || "Tú");
    load();
  }, [load]);
  useEffect(() => {
    if (!activeBotId) return;
    let disposed = false;
    setMessages([]);
    setHistoryLoading(true);
    fetchChatHistory(activeBotId)
      .then((history) => {
        if (!disposed) setMessages(history);
      })
      .catch((failure) => {
        if (!disposed) setError(failure.message);
      })
      .finally(() => {
        if (!disposed) setHistoryLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [activeBotId]);

  const activeBot = bots.find((bot) => bot.id === activeBotId) || bots[0];
  function selectTab(tab) {
    setActiveTab(tab);
    closeSidebar();
  }
  function openChat(id, prompt = "") {
    setActiveBotId(id);
    setActiveTab("chat");
    closeSidebar();
    setDraft({ botId: id, text: prompt, key: Date.now() });
  }
  async function updateModel(id, model) {
    const updated = await updateBot(id, { model });
    setBots((previous) =>
      previous.map((bot) => (bot.id === id ? updated : bot)),
    );
  }
  async function create(data) {
    const bot = await createBot(data);
    setBots((previous) => [...previous, bot]);
    openChat(bot.id);
  }
  return (
    <div className="studio-app" ref={glassRef}>
      <Sidebar
        onLogout={onLogout}
        bots={bots}
        activeBotId={activeBotId}
        userName={userName}
        onSelectBot={openChat}
        activeTab={activeTab}
        onSelectTab={selectTab}
        onOpenSettings={() => {
          closeSidebar();
          setIsSettingsOpen(true);
        }}
        onOpenNewBot={() => {
          closeSidebar();
          setCreateOpen(true);
        }}
        isOpen={sidebarOpen}
        onClose={closeSidebar}
        providerConfigured={providerConfigured}
      />
      <main className="workspace-main">
        <header className="workspace-topbar">
          <div className="workspace-breadcrumb">
            <button
              className="icon-button mobile-only"
              onClick={() => setSidebarOpen(true)}
              aria-label="Abrir menú"
              aria-expanded={sidebarOpen}
            >
              <FiMenu />
            </button>
            <span className="breadcrumb-root">Mi espacio</span>
            <FiChevronRight />
            <span>{tabNames[activeTab]}</span>
          </div>
          <div className="topbar-actions">
            <span className="private-badge">
              <FiLock />
              Personal y privado
            </span>
            <button
              className="compact-button"
              onClick={() => setCreateOpen(true)}
            >
              <FiPlus />
              <span>Nuevo Dot</span>
            </button>
          </div>
        </header>
        {error && (
          <div role="alert" className="workspace-error">
            <FiAlertCircle />
            <span>{error}</span>
            <button className="text-button" onClick={load}>
              <FiRefreshCw />
              Reintentar
            </button>
            <button className="text-button" onClick={() => setError("")}>
              Cerrar
            </button>
          </div>
        )}
        <div key={activeTab} className={`workspace-content view-${activeTab}`}>
          {activeTab === "overview" && (
            <Overview
              bots={bots}
              userName={userName}
              onChat={openChat}
              onCreate={() => setCreateOpen(true)}
              onTab={selectTab}
              loading={loading}
            />
          )}
          {activeTab === "chat" && (
            <ChatWindow
              bot={activeBot}
              models={models}
              messages={messages}
              setMessages={setMessages}
              onUpdateBotModel={updateModel}
              onToggleComputer={() => selectTab("computer")}
              defaultModel={defaultModel}
              draft={draft}
              historyLoading={historyLoading}
            />
          )}
          {activeTab === "computer" && (
            <ComputerPanel
              bot={activeBot}
              onBackToChat={() => selectTab("chat")}
            />
          )}
          {activeTab === "marketplace" && (
            <Marketplace onOpenSettings={() => setIsSettingsOpen(true)} onOpenContact={() => selectTab("contact")} onOpenChat={() => selectTab("chat")} />
          )}
          {activeTab === "audit" && <AuditPanel />}
          {activeTab === "contact" && (
            <ContactPanel bots={bots} bot={activeBot} />
          )}
          {activeTab === "team" && (
            <TeamPanel bots={bots} providerConfigured={providerConfigured} onOpenSettings={() => setIsSettingsOpen(true)} />
          )}
          {["memory", "routines"].includes(activeTab) && (
            <AgentStatePanel
              key={`${activeBotId}-${activeTab}`}
              bot={activeBot}
              mode={activeTab}
            />
          )}
        </div>
      </main>
        <AppSettingsDrawer
          onOpenConnectors={() => { closeSettings(); selectTab("marketplace"); }}
        bot={activeBot}
        onUpdateRules={async (id, rules) => {
          const updated = await updateBot(id, { system_prompt: rules });
          setBots((previous) =>
            previous.map((bot) => (bot.id === id ? updated : bot)),
          );
        }}
        models={models}
        isOpen={isSettingsOpen}
        onClose={closeSettings}
        currentModel={defaultModel}
        onUpdateDefaultModel={async (model) => {
          setDefaultModel(model);
          const [modelData, config] = await Promise.all([
            fetchModels(),
            fetchSettings(),
          ]);
          setModels(modelData);
          setProviderConfigured(Boolean(config.model_api_key_configured));
        }}
        onProfileUpdate={(name) => setUserName(name || "Tú")}
      />
      {createOpen && (
        <CreateDotDialog
          defaultModel={defaultModel}
          onCreate={create}
          onClose={closeCreate}
        />
      )}
    </div>
  );
}
