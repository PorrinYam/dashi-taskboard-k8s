import { useEffect, useState, type FormEvent } from "react";

import { useTaskboardI18n } from "../i18n";

const DEFAULT_CLOUD_URL = "https://devtb.appreach.cn";

interface CloudConnectionDialogProps {
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: {
    remoteUrl: string;
    actorName: string;
    sharedKey: string;
  }) => Promise<void>;
}

export function CloudConnectionDialog({
  saving,
  error,
  onClose,
  onSave,
}: CloudConnectionDialogProps) {
  const { text } = useTaskboardI18n();
  const [remoteUrl, setRemoteUrl] = useState(DEFAULT_CLOUD_URL);
  const [credentials, setCredentials] = useState("");

  useEffect(() => {
    setRemoteUrl(DEFAULT_CLOUD_URL);
    setCredentials("");
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const composite = credentials.trim();
    const separator = composite.indexOf(":");
    if (separator <= 0 || separator === composite.length - 1) {
      return;
    }
    await onSave({
      remoteUrl: remoteUrl.trim(),
      // The device id doubles as the local actor display name; the server rejects ':'.
      actorName: composite.slice(0, separator),
      sharedKey: composite,
    });
  }

  const credentialsShapeValid = /^[^:\s]+:[^:]+$/.test(credentials.trim());

  return (
    <div
      className="delete-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <form
        className="delete-dialog project-create-dialog jira-connection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-connection-title"
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onClose();
        }}
      >
        <h2 id="cloud-connection-title">{text("连接 devtb", "Connect devtb")}</h2>
        <label>
          <span>{text("云端地址", "Cloud URL")}</span>
          <input
            autoFocus
            required
            inputMode="url"
            maxLength={2048}
            placeholder="https://devtb.appreach.cn"
            value={remoteUrl}
            onChange={(event) => setRemoteUrl(event.target.value)}
          />
        </label>
        <label>
          <span>{text("设备凭据", "Device credentials")}</span>
          <input
            required
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={512}
            placeholder="<deviceId>:<token>"
            value={credentials}
            onChange={(event) => setCredentials(event.target.value)}
          />
        </label>
        {!credentialsShapeValid && (
          <p className="jira-http-warning">
            {text("格式：deviceId:token（向管理员索取，一行粘贴）", "Format: deviceId:token (paste the issued line)")}
          </p>
        )}
        {error && <p className="project-dialog-error" role="alert">{error}</p>}
        <div>
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>
            {text("取消", "Cancel")}
          </button>
          <button className="button primary" type="submit" disabled={saving}>
            {saving ? text("连接中…", "Connecting…") : text("连接", "Connect")}
          </button>
        </div>
      </form>
    </div>
  );
}
