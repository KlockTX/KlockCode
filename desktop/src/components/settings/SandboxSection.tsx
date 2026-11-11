import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuShield, LuShieldCheck } from "react-icons/lu";
import {
  getSandbox,
  setSandbox,
  type SandboxSettings,
  type SandboxStatus,
} from "../../api";
import { Button } from "../ui/Button";
import { CustomSelect, type CustomSelectOption } from "../ui/CustomSelect";
import { Dialog } from "../ui/Dialog";
import { FieldRow, Section } from "../ui/Section";
import { Spinner } from "../ui/Spinner";
import { Toggle } from "../ui/Toggle";
import "./SandboxSection.css";

type SandboxMode = "full-access" | "workspace-write" | "read-only";

/**
 * 沙箱分区：「沙箱模式」与「文件删除确认」两行。
 *
 * 模式映射：完全访问 = enabled:false；工作区写入 / 只读 = enabled:true + 对应 mode。
 * 只读模式不写任何 ACL（连工作区都不授权），所以不需要风险确认弹窗；
 * 工作区写入会改动工作区 ACL，必须先看风险说明。
 * 文件删除确认只在工作区写入模式下有意义；其余两种显示为关闭且不可操作。
 */
export function SandboxSection({ onToast }: { onToast: (text: string) => void }) {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [pendingMode, setPendingMode] = useState<SandboxMode | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await getSandbox());
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("sandbox.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [onToast, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const persist = async (next: SandboxStatus) => {
    await window.meow.saveProviderPrefs({
      sandbox: {
        enabled: next.enabled,
        mode: next.mode,
        writableRoots: next.writableRoots,
        allowTemp: next.allowTemp,
        grantTimeoutMs: next.grantTimeoutMs,
        confirmDelete: next.confirmDelete,
      },
    });
  };

  const apply = async (patch: Partial<SandboxSettings>) => {
    if (!status) return;
    const previous = status;
    const merged = { ...status, ...patch };
    setStatus(merged);
    setBusy(true);
    try {
      const next = await setSandbox({
        enabled: merged.enabled,
        mode: merged.mode,
        writableRoots: merged.writableRoots,
        allowTemp: merged.allowTemp,
        grantTimeoutMs: merged.grantTimeoutMs,
        confirmDelete: merged.confirmDelete,
      });
      setStatus(next);
      await persist(next);
      if (next.probeDurationMs !== undefined) {
        onToast(
          t(next.mode === "read-only" ? "sandbox.enabledReadOnly" : "sandbox.enabled", {
            ms: next.probeDurationMs,
          }),
        );
      }
    } catch (error) {
      setStatus(previous);
      onToast(error instanceof Error ? error.message : t("sandbox.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (loading || !status) {
    return (
      <div className="mc-settings__inner">
        <div className="mc-sandbox__loading">
          <Spinner size={16} />
        </div>
      </div>
    );
  }

  const mode: SandboxMode = status.enabled ? status.mode : "full-access";
  const modeOptions: Array<CustomSelectOption<SandboxMode>> = [
    {
      value: "full-access",
      label: t("sandbox.modeFull"),
      description: t("sandbox.modeFullDesc"),
    },
    {
      value: "workspace-write",
      label: t("sandbox.modeWorkspace"),
      description: t("sandbox.modeWorkspaceDesc"),
    },
    {
      value: "read-only",
      label: t("sandbox.modeReadOnly"),
      description: t("sandbox.modeReadOnlyDesc"),
    },
  ];

  const changeMode = (next: SandboxMode) => {
    if (next === mode) return;
    if (next === "workspace-write") {
      // 会改写工作区 ACL：先看风险说明再开
      setPendingMode(next);
      setConfirmEnable(true);
      return;
    }
    if (next === "read-only") {
      // 不写 ACL、不发 temp，只是把命令降成只读——不需要风险确认
      void apply({ enabled: true, mode: "read-only" });
      return;
    }
    void apply({ enabled: false });
  };

  const confirmSwitch = () => {
    setConfirmEnable(false);
    if (pendingMode === "workspace-write") {
      void apply({ enabled: true, mode: "workspace-write" });
    }
    setPendingMode(null);
  };

  const cancelSwitch = () => {
    setConfirmEnable(false);
    setPendingMode(null);
  };

  return (
    <div className="mc-settings__inner">
      <Section title={t("sandbox.title")}>
        <FieldRow label={t("sandbox.modeField")} hint={t("sandbox.modeDesc")}>
          <CustomSelect
            value={mode}
            options={modeOptions}
            onChange={changeMode}
            ariaLabel={t("sandbox.modeField")}
            icon={mode === "full-access" ? <LuShield size={14} /> : <LuShieldCheck size={14} />}
            className="mc-sandbox__mode"
            disabled={busy || !status.supported}
          />
        </FieldRow>

        <FieldRow label={t("sandbox.deleteField")} hint={t("sandbox.deleteDesc")}>
          <Toggle
            checked={status.enabled && status.mode === "workspace-write" && status.confirmDelete}
            onChange={(value) => void apply({ confirmDelete: value })}
            disabled={busy || !status.enabled || status.mode !== "workspace-write"}
            label={t("sandbox.deleteField")}
          />
        </FieldRow>

        {!status.supported ? <p className="mc-sandbox__warn">{t("sandbox.unsupported")}</p> : null}
      </Section>

      <Dialog
        open={confirmEnable}
        onClose={cancelSwitch}
        labelledBy="mc-sandbox-risk-title"
      >
        <span className="mc-dialog__title" id="mc-sandbox-risk-title">
          {t("sandbox.riskTitle")}
        </span>
        <p className="mc-dialog__desc">{t("sandbox.riskDoes")}</p>
        <div className="mc-sandbox__note">
          <p>{t("sandbox.riskDoesNot")}</p>
          <p>{t("sandbox.riskUndo")}</p>
        </div>
        <div className="mc-dialog__footer">
          <Button variant="ghost" onClick={cancelSwitch}>
            {t("sandbox.cancel")}
          </Button>
          <Button variant="primary" onClick={confirmSwitch}>
            {t("sandbox.confirmEnable")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
