// Netpa Calendar Sync - popup

const runBtn = document.getElementById("run");
const weeksInput = document.getElementById("weeks");
const status = document.getElementById("status");

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = kind;
}

runBtn.addEventListener("click", async () => {
  const weeks = Math.min(52, Math.max(1, parseInt(weeksInput.value, 10) || 20));

  runBtn.disabled = true;
  setStatus("Reading weeks from Netpa ...");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !/^https:\/\/netpa\.novasbe\.pt\/netpa\/DIFTasks/.test(tab.url || "")) {
      throw new Error("Open the Weekly Schedule in Netpa first.");
    }

    const res = await chrome.tabs.sendMessage(tab.id, { action: "build_ics", weeks });

    if (!res) throw new Error("No answer from the page. Reload the Netpa tab and try again.");
    if (res.error) throw new Error(res.error);
    if (!res.count) throw new Error("No classes found. Is this week inside the semester?");

    download(res.ics);

    const note = res.sessionLost
      ? ` Stopped after ${res.weeks} weeks, your Netpa session expired. Log in again and export once more.`
      : "";
    setStatus(
      `Exported ${res.count} classes from ${res.weeks} weeks.${note}`,
      res.sessionLost ? "err" : "ok"
    );
  } catch (err) {
    const msg = String(err && err.message || err);
    setStatus(
      /Receiving end does not exist/i.test(msg)
        ? "Reload the Netpa tab once, then try again."
        : msg,
      "err"
    );
  } finally {
    runBtn.disabled = false;
  }
});

function download(ics) {
  const stamp = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `netpa-schedule-${stamp}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
