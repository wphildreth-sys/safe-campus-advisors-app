import React, { useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { jsPDF } from "jspdf";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

const INSIDE_SECTIONS = [
  { id: "school-interior", title: "School Interior", items: [
    "Main entrance signage directs visitors to the office",
    "Entrance lobby is visible from the main office",
    "Visitors sign in and out at the main office",
    "Hallways are clear and unencumbered",
    "Classroom doors remain closed and locked during instruction",
    "Emergency evacuation routes are posted"
  ]},
  { id: "main-entry-office", title: "Main Entry and Main Office", items: [
    "Entry has buzzer or controlled access",
    "Secure vestibule channels visitors to office",
    "Visitor management process is documented and followed",
    "Office duress alert or panic capability is available",
    "Staff display photo ID badges"
  ]}
];

const OUTSIDE_SECTIONS = [
  { id: "grounds-perimeter", title: "Grounds, Perimeter, and Access", items: [
    "Campus drive entrance is clearly marked",
    "Main building entrance is clearly marked",
    "Visitor parking is designated and observable",
    "Fencing and gates are maintained and secured",
    "Exterior doors are secured and functioning properly"
  ]},
  { id: "exterior-surveillance-lighting", title: "Exterior Surveillance and Lighting", items: [
    "Exterior cameras cover key approach areas",
    "Parking lots can be visually monitored",
    "Night lighting supports safety and camera coverage",
    "Entrances and intrusion-prone points are lit",
    "Parking areas are patrolled or routinely observed"
  ]}
];

const findingOptions = ["Compliant", "Needs Improvement", "Critical Concern", "Not Observed", "N/A"];
const riskOptions = ["Low", "Medium", "High"];

function uid() { return Math.random().toString(36).slice(2, 10); }

function buildItems(sectionList, area) {
  return sectionList.flatMap((section) =>
    section.items.map((label) => ({
      local_id: uid(), area, section_id: section.id, section_title: section.title, label,
      response: "Not Observed", risk: "Medium", notes: "",
      gps_latitude: null, gps_longitude: null, gps_accuracy: null, gps_captured_at: null,
      attachments: []
    }))
  );
}

function buildAssessment(name = "New School Safety Assessment") {
  return {
    id: null, local_id: uid(), name, status: "Draft",
    school_name: "", district: "", address: "", principal: "", assessor: "",
    assessment_date: new Date().toISOString().slice(0, 10),
    summary: "", priority_actions: "",
    insideItems: buildItems(INSIDE_SECTIONS, "inside"),
    outsideItems: buildItems(OUTSIDE_SECTIONS, "outside")
  };
}

function scoreAssessment(assessment) {
  const items = [...assessment.insideItems, ...assessment.outsideItems].filter((i) => i.response !== "N/A");
  const total = Math.max(items.length, 1);
  const critical = items.filter((i) => i.response === "Critical Concern").length;
  const needs = items.filter((i) => i.response === "Needs Improvement").length;
  const compliant = items.filter((i) => i.response === "Compliant").length;
  const notObserved = items.filter((i) => i.response === "Not Observed").length;
  const score = Math.max(0, Math.round(100 - (critical * 18 + needs * 8 + notObserved * 3) / Math.max(total / 10, 1)));
  const level = score >= 85 ? "Low" : score >= 70 ? "Moderate" : score >= 50 ? "Elevated" : "High";
  return { total, critical, needs, compliant, notObserved, score, level };
}

function groupBySection(items) {
  return items.reduce((acc, item) => {
    if (!acc[item.section_title]) acc[item.section_title] = [];
    acc[item.section_title].push(item);
    return acc;
  }, {});
}

async function signInWithMagicLink(email) {
  if (!supabase) throw new Error("Supabase environment variables are missing.");
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
  if (error) throw error;
}

async function signInWithProvider(provider) {
  if (!supabase) throw new Error("Supabase environment variables are missing.");
  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: window.location.href, queryParams: provider === "google" ? { access_type: "offline", prompt: "consent" } : undefined }
  });
  if (error) throw error;
}

async function fetchAssessments(userId) {
  const { data: assessments, error } = await supabase
    .from("assessments")
    .select("*, assessment_items(*), assessment_files(*)")
    .eq("owner_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw error;

  return (assessments || []).map((row) => {
    const filesByItemId = new Map();
    (row.assessment_files || []).forEach((file) => {
      const bucket = filesByItemId.get(file.assessment_item_id) || [];
      bucket.push({ id: file.id, name: file.file_name, public_url: file.public_url, storage_path: file.storage_path, mime_type: file.mime_type });
      filesByItemId.set(file.assessment_item_id, bucket);
    });

    const insideItems = (row.assessment_items || []).filter((i) => i.area === "inside").map((i) => ({ ...i, local_id: i.id, attachments: filesByItemId.get(i.id) || [] }));
    const outsideItems = (row.assessment_items || []).filter((i) => i.area === "outside").map((i) => ({ ...i, local_id: i.id, attachments: filesByItemId.get(i.id) || [] }));

    return {
      id: row.id, local_id: row.id, name: row.name, status: row.status,
      school_name: row.school_name || "", district: row.district || "", address: row.address || "",
      principal: row.principal || "", assessor: row.assessor || "", assessment_date: row.assessment_date || "",
      summary: row.summary || "", priority_actions: row.priority_actions || "",
      insideItems, outsideItems
    };
  });
}

async function saveAssessmentToSupabase(assessment, userId) {
  const assessmentPayload = {
    owner_id: userId, name: assessment.name, status: assessment.status,
    school_name: assessment.school_name, district: assessment.district, address: assessment.address,
    principal: assessment.principal, assessor: assessment.assessor, assessment_date: assessment.assessment_date,
    summary: assessment.summary, priority_actions: assessment.priority_actions, updated_at: new Date().toISOString()
  };

  let assessmentId = assessment.id;
  if (!assessmentId) {
    const { data, error } = await supabase.from("assessments").insert(assessmentPayload).select().single();
    if (error) throw error;
    assessmentId = data.id;
  } else {
    const { error } = await supabase.from("assessments").update(assessmentPayload).eq("id", assessmentId);
    if (error) throw error;
  }

  const items = [...assessment.insideItems, ...assessment.outsideItems].map((item) => ({
    id: item.id || undefined, assessment_id: assessmentId, area: item.area, section_id: item.section_id,
    section_title: item.section_title, label: item.label, response: item.response, risk: item.risk, notes: item.notes,
    gps_latitude: item.gps_latitude, gps_longitude: item.gps_longitude, gps_accuracy: item.gps_accuracy, gps_captured_at: item.gps_captured_at
  }));

  const { data: upserted, error: itemsError } = await supabase.from("assessment_items").upsert(items, { onConflict: "id" }).select();
  if (itemsError) throw itemsError;

  const itemIdByKey = new Map((upserted || []).map((item) => [`${item.area}:${item.section_id}:${item.label}`, item.id]));
  return {
    ...assessment, id: assessmentId,
    insideItems: assessment.insideItems.map((item) => ({ ...item, id: item.id || itemIdByKey.get(`${item.area}:${item.section_id}:${item.label}`) })),
    outsideItems: assessment.outsideItems.map((item) => ({ ...item, id: item.id || itemIdByKey.get(`${item.area}:${item.section_id}:${item.label}`) }))
  };
}

async function uploadEvidenceFile(file, assessmentId, assessmentItemId) {
  const extension = file.name.split(".").pop();
  const storagePath = `${assessmentId}/${assessmentItemId}/${crypto.randomUUID()}.${extension}`;
  const { error: uploadError } = await supabase.storage.from("assessment-files").upload(storagePath, file, { cacheControl: "3600", upsert: false });
  if (uploadError) throw uploadError;
  const { data: publicUrlData } = supabase.storage.from("assessment-files").getPublicUrl(storagePath);
  const publicUrl = publicUrlData.publicUrl;
  const { data, error } = await supabase.from("assessment_files").insert({
    assessment_id: assessmentId, assessment_item_id: assessmentItemId, file_name: file.name,
    storage_path: storagePath, public_url: publicUrl, mime_type: file.type || "application/octet-stream"
  }).select().single();
  if (error) throw error;
  return { id: data.id, name: data.file_name, public_url: data.public_url, storage_path: data.storage_path, mime_type: data.mime_type };
}

async function deleteEvidenceFile(fileId, storagePath) {
  await supabase.storage.from("assessment-files").remove([storagePath]);
  const { error } = await supabase.from("assessment_files").delete().eq("id", fileId);
  if (error) throw error;
}

function exportAssessmentPdf(assessment) {
  const pdf = new jsPDF({ unit: "pt", format: "letter" });
  const margin = 48;
  const pageWidth = pdf.internal.pageSize.getWidth();
  const usableWidth = pageWidth - margin * 2;
  let y = 56;
  const score = scoreAssessment(assessment);
  const allItems = [...assessment.insideItems, ...assessment.outsideItems];
  const criticalItems = allItems.filter((i) => i.response === "Critical Concern");
  const needsItems = allItems.filter((i) => i.response === "Needs Improvement");

  const title = (text, size = 22) => { pdf.setFont("helvetica", "bold"); pdf.setFontSize(size); pdf.text(text, margin, y); y += size + 10; };
  const line = (text, size = 11, bold = false) => {
    pdf.setFont("helvetica", bold ? "bold" : "normal");
    pdf.setFontSize(size);
    const split = pdf.splitTextToSize(text, usableWidth);
    pdf.text(split, margin, y);
    y += split.length * (size + 3) + 6;
    if (y > 720) { pdf.addPage(); y = 56; }
  };

  title("Safe Campus Advisors LLC", 24);
  line("Board-Ready School Safety Assessment Report", 14, true);
  line(`Assessment: ${assessment.name}`, 11, true);
  line(`School: ${assessment.school_name || "—"}`);
  line(`District: ${assessment.district || "—"}`);
  line(`Principal: ${assessment.principal || "—"}`);
  line(`Assessor: ${assessment.assessor || "—"}`);
  line(`Overall Risk Score: ${score.score}/100 (${score.level})`, 12, true);
  title("Executive Summary", 16);
  line(assessment.summary || `This assessment identified ${score.critical} critical concerns and ${score.needs} findings needing improvement.`);
  title("Critical Concerns", 16);
  if (!criticalItems.length) line("None recorded.");
  criticalItems.forEach((item, i) => line(`${i + 1}. ${item.section_title}: ${item.label}`));
  title("Needs Improvement", 16);
  if (!needsItems.length) line("None recorded.");
  needsItems.forEach((item, i) => line(`${i + 1}. ${item.section_title}: ${item.label}`));
  title("Priority Actions", 16);
  line(assessment.priority_actions || "No priority actions entered.");
  pdf.save(`${(assessment.school_name || "safe-campus-report").replace(/\s+/g, "-").toLowerCase()}.pdf`);
}

function LoginScreen({ onMagicLink, onProvider, loading, envReady, error }) {
  const [email, setEmail] = useState("");
  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="brand-header">
          <img src="/logo.png" alt="Safe Campus Advisors LLC" className="brand-logo" />
          <div><h1>Safe Campus Advisors LLC</h1><p>SSO-Ready School Safety Audit Platform</p></div>
        </div>
        {!envReady && <div className="alert warn">Supabase environment variables are missing.</div>}
        {error && <div className="alert error">{error}</div>}
        <div className="button-grid">
          <button className="btn btn-outline" disabled={!envReady || loading} onClick={() => onProvider("google")}>Continue with Google</button>
          <button className="btn btn-outline" disabled={!envReady || loading} onClick={() => onProvider("azure")}>Continue with Microsoft</button>
        </div>
        <div className="divider"><span>Or use email</span></div>
        <label>Email address</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@district.org" />
        <button className="btn btn-primary full" disabled={!envReady || loading || !email} onClick={() => onMagicLink(email)}>{loading ? "Sending..." : "Send Magic Link"}</button>
        <div className="help-text">Enable Email, Google, and Azure providers in Supabase Auth and add your deployed URL as a redirect.</div>
      </div>
    </div>
  );
}

function SectionEditor({ title, items, area, onItemChange, onCaptureGps, onUploadFiles, onDeleteFile }) {
  const grouped = groupBySection(items);
  return (
    <div className="card">
      <div className="card-header"><h3>{title}</h3><p>Capture findings, notes, evidence files, and GPS location.</p></div>
      <div className="card-body">
        {Object.entries(grouped).map(([sectionTitle, sectionItems]) => (
          <details key={sectionTitle} className="section-block" open>
            <summary>{sectionTitle}</summary>
            {sectionItems.map((item, idx) => {
              const itemKey = String(item.id || item.local_id);
              return (
                <div className="item-card" key={itemKey}>
                  <div className="item-head">
                    <div><div className="meta">Item {idx + 1}</div><div className="item-label">{item.label}</div></div>
                    <div className="select-grid">
                      <div><label>Finding</label><select value={item.response} onChange={(e) => onItemChange(area, itemKey, { response: e.target.value })}>{findingOptions.map((opt) => <option key={opt} value={opt}>{opt}</option>)}</select></div>
                      <div><label>Risk</label><select value={item.risk} onChange={(e) => onItemChange(area, itemKey, { risk: e.target.value })}>{riskOptions.map((opt) => <option key={opt} value={opt}>{opt}</option>)}</select></div>
                    </div>
                  </div>
                  <label>Observation Notes</label>
                  <textarea rows="3" value={item.notes || ""} onChange={(e) => onItemChange(area, itemKey, { notes: e.target.value })} />
                  <div className="button-row">
                    <label className="btn btn-outline file-label">Add Photos / Files<input type="file" multiple hidden onChange={(e) => onUploadFiles(area, itemKey, e.target.files)} /></label>
                    <button className="btn btn-outline" onClick={() => onCaptureGps(area, itemKey)}>Capture GPS</button>
                  </div>
                  {item.gps_latitude && <div className="gps-box">GPS: {Number(item.gps_latitude).toFixed(6)}, {Number(item.gps_longitude).toFixed(6)}</div>}
                  {!!item.attachments?.length && (
                    <div className="evidence-grid">
                      {item.attachments.map((file) => (
                        <div key={file.id} className="evidence-card">
                          <div className="evidence-top">
                            <div><div className="evidence-name">{file.name}</div><div className="meta">Stored in Supabase</div></div>
                            <button className="icon-btn" onClick={() => onDeleteFile(area, itemKey, file)}>✕</button>
                          </div>
                          {file.mime_type?.startsWith("image/") ? <img src={file.public_url} alt={file.name} className="evidence-image" /> : <div className="file-box">File</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </details>
        ))}
      </div>
    </div>
  );
}

function ReportView({ assessment }) {
  const score = scoreAssessment(assessment);
  const allItems = [...assessment.insideItems, ...assessment.outsideItems];
  const criticalItems = allItems.filter((i) => i.response === "Critical Concern");
  const needsItems = allItems.filter((i) => i.response === "Needs Improvement");
  return (
    <div className="card">
      <div className="card-header report-header">
        <div><h3>Board-Ready Report Preview</h3><p>Executive summary, key findings, and export-ready structure.</p></div>
        <button className="btn btn-primary" onClick={() => exportAssessmentPdf(assessment)}>Export PDF</button>
      </div>
      <div className="card-body report-grid">
        <div className="stat"><div className="meta">Risk Score</div><strong>{score.score}/100</strong><span>{score.level}</span></div>
        <div className="stat"><div className="meta">Compliant</div><strong>{score.compliant}</strong></div>
        <div className="stat"><div className="meta">Needs Improvement</div><strong>{score.needs}</strong></div>
        <div className="stat"><div className="meta">Critical</div><strong>{score.critical}</strong></div>
        <div className="summary-box"><h4>Executive Summary</h4><p>{assessment.summary || `This site currently reflects a ${score.level.toLowerCase()} risk posture with ${score.critical} critical concerns and ${score.needs} findings needing improvement.`}</p></div>
        <div className="finding-box critical"><h4>Critical Concerns</h4><ul>{criticalItems.length ? criticalItems.map((item) => <li key={item.id || item.local_id}>{item.section_title}: {item.label}</li>) : <li>None recorded.</li>}</ul></div>
        <div className="finding-box warning"><h4>Needs Improvement</h4><ul>{needsItems.length ? needsItems.map((item) => <li key={item.id || item.local_id}>{item.section_title}: {item.label}</li>) : <li>None recorded.</li>}</ul></div>
        <div className="summary-box"><h4>Priority Actions</h4><p>{assessment.priority_actions || "No priority actions entered."}</p></div>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [assessments, setAssessments] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [newName, setNewName] = useState("");
  const [search, setSearch] = useState("");

  const envReady = Boolean(supabase);

  useEffect(() => {
    if (!supabase) { setLoading(false); return; }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session ?? null); setLoading(false); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => { setSession(nextSession); });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    async function loadAssessments() {
      if (!session?.user?.id || !supabase) return;
      try {
        setLoading(true);
        const rows = await fetchAssessments(session.user.id);
        if (rows.length) { setAssessments(rows); setActiveId(String(rows[0].id || rows[0].local_id)); }
        else { const starter = buildAssessment("Campus Safety Baseline Review"); setAssessments([starter]); setActiveId(starter.local_id); }
      } catch (err) { setError(err.message || "Failed to load assessments."); }
      finally { setLoading(false); }
    }
    loadAssessments();
  }, [session?.user?.id]);

  const activeAssessment = useMemo(() => assessments.find((a) => String(a.id || a.local_id) === String(activeId)) || assessments[0] || null, [assessments, activeId]);
  const filteredAssessments = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return assessments;
    return assessments.filter((a) => [a.name, a.school_name, a.district, a.assessor, a.status].join(" ").toLowerCase().includes(q));
  }, [assessments, search]);

  const metrics = useMemo(() => {
    if (!activeAssessment) return { total: 0, critical: 0, needs: 0, score: 0, level: "Low", files: 0 };
    const s = scoreAssessment(activeAssessment);
    const files = [...activeAssessment.insideItems, ...activeAssessment.outsideItems].reduce((sum, item) => sum + (item.attachments?.length || 0), 0);
    return { ...s, files };
  }, [activeAssessment]);

  const updateAssessment = (updater) => {
    setAssessments((prev) => prev.map((assessment) => {
      const key = String(assessment.id || assessment.local_id);
      if (key !== String(activeId)) return assessment;
      return updater(assessment);
    }));
  };

  const createAssessment = () => {
    const created = buildAssessment(newName.trim() || `Assessment ${assessments.length + 1}`);
    setAssessments((prev) => [created, ...prev]);
    setActiveId(created.local_id);
    setNewName("");
  };

  const onItemChange = (area, itemKey, patch) => {
    const collectionKey = area === "inside" ? "insideItems" : "outsideItems";
    updateAssessment((assessment) => ({
      ...assessment,
      [collectionKey]: assessment[collectionKey].map((item) => String(item.id || item.local_id) === String(itemKey) ? { ...item, ...patch } : item)
    }));
  };

  const onCaptureGps = (area, itemKey) => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        onItemChange(area, itemKey, {
          gps_latitude: position.coords.latitude,
          gps_longitude: position.coords.longitude,
          gps_accuracy: position.coords.accuracy,
          gps_captured_at: new Date().toISOString()
        });
      },
      () => setError("Unable to capture GPS."),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const saveCurrent = async (statusOverride) => {
    if (!session?.user?.id || !activeAssessment || !supabase) return;
    try {
      setWorking(true); setError("");
      const saved = await saveAssessmentToSupabase(statusOverride ? { ...activeAssessment, status: statusOverride } : activeAssessment, session.user.id);
      setAssessments((prev) => prev.map((a) => String(a.id || a.local_id) === String(activeId) ? saved : a));
      setActiveId(String(saved.id || saved.local_id));
    } catch (err) { setError(err.message || "Save failed."); }
    finally { setWorking(false); }
  };

  const onUploadFiles = async (area, itemKey, fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length || !activeAssessment || !session?.user?.id || !supabase) return;
    try {
      setWorking(true); setError("");
      let saved = activeAssessment;
      if (!saved.id) {
        saved = await saveAssessmentToSupabase(saved, session.user.id);
        setAssessments((prev) => prev.map((a) => String(a.id || a.local_id) === String(activeId) ? saved : a));
        setActiveId(String(saved.id || saved.local_id));
      }
      const collectionKey = area === "inside" ? "insideItems" : "outsideItems";
      const target = saved[collectionKey].find((item) => String(item.id || item.local_id) === String(itemKey));
      if (!target?.id) throw new Error("Please save the assessment before uploading files.");

      const uploaded = [];
      for (const file of files) uploaded.push(await uploadEvidenceFile(file, saved.id, target.id));

      setAssessments((prev) => prev.map((assessment) => {
        if (String(assessment.id || assessment.local_id) !== String(saved.id || saved.local_id)) return assessment;
        return {
          ...assessment,
          [collectionKey]: assessment[collectionKey].map((item) =>
            String(item.id || item.local_id) === String(itemKey) ? { ...item, attachments: [...(item.attachments || []), ...uploaded] } : item
          )
        };
      }));
    } catch (err) { setError(err.message || "Upload failed."); }
    finally { setWorking(false); }
  };

  const onDeleteFile = async (area, itemKey, file) => {
    try {
      setWorking(true); setError("");
      await deleteEvidenceFile(file.id, file.storage_path);
      const collectionKey = area === "inside" ? "insideItems" : "outsideItems";
      setAssessments((prev) => prev.map((assessment) => {
        if (String(assessment.id || assessment.local_id) !== String(activeId)) return assessment;
        return {
          ...assessment,
          [collectionKey]: assessment[collectionKey].map((item) =>
            String(item.id || item.local_id) === String(itemKey) ? { ...item, attachments: (item.attachments || []).filter((f) => f.id !== file.id) } : item
          )
        };
      }));
    } catch (err) { setError(err.message || "Delete failed."); }
    finally { setWorking(false); }
  };

  const handleMagicLink = async (email) => {
    try { setWorking(true); setError(""); await signInWithMagicLink(email); alert("Magic link sent. Check your email."); }
    catch (err) { setError(err.message || "Login failed."); }
    finally { setWorking(false); }
  };

  const handleProvider = async (provider) => {
    try { setWorking(true); setError(""); await signInWithProvider(provider); }
    catch (err) { setError(err.message || `Unable to start ${provider} sign-in.`); setWorking(false); }
  };

  if (!session) return <LoginScreen onMagicLink={handleMagicLink} onProvider={handleProvider} loading={working} envReady={envReady} error={error} />;
  if (loading || !activeAssessment) return <div className="center-screen">Loading…</div>;

  return (
    <div className="app-shell">
      <header className="top-banner">
        <div className="brand-wrap">
          <img src="/logo.png" alt="Safe Campus Advisors LLC" className="brand-logo" />
          <div><h1>Safe Campus Advisors LLC</h1><p>SSO-Ready School Safety Audit Platform</p></div>
        </div>
        <div className="top-actions">
          <span className="user-pill">{session.user.email}</span>
          <button className="btn btn-outline" onClick={() => supabase.auth.signOut()}>Sign Out</button>
        </div>
      </header>

      {error && <div className="alert error app-alert">{error}</div>}

      <div className="layout">
        <aside className="sidebar card">
          <div className="card-header"><h3>Assessments</h3><p>Create and manage school safety reviews.</p></div>
          <div className="card-body">
            <label>New Assessment</label>
            <div className="row"><input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Spring 2026 Assessment" /><button className="btn btn-primary" onClick={createAssessment}>Create</button></div>
            <label>Search</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by school or district" />
            <div className="assessment-list">
              {filteredAssessments.map((assessment) => {
                const key = String(assessment.id || assessment.local_id);
                return (
                  <button key={key} className={`assessment-tile ${String(activeId) === key ? "active" : ""}`} onClick={() => setActiveId(key)}>
                    <div className="tile-top"><strong>{assessment.name}</strong><span className={`status-badge ${assessment.status === "Finalized" ? "finalized" : ""}`}>{assessment.status}</span></div>
                    <div className="meta">{assessment.school_name || "No school entered"}</div>
                    <div className="meta">{assessment.district || "No district entered"}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <main className="main-area">
          <div className="stats-grid">
            <div className="stat-card"><div className="meta">Risk Score</div><strong>{metrics.score}/100</strong><span>{metrics.level}</span></div>
            <div className="stat-card"><div className="meta">Checklist Items</div><strong>{metrics.total}</strong></div>
            <div className="stat-card"><div className="meta">Critical</div><strong>{metrics.critical}</strong></div>
            <div className="stat-card"><div className="meta">Needs Improvement</div><strong>{metrics.needs}</strong></div>
            <div className="stat-card"><div className="meta">Evidence Files</div><strong>{metrics.files}</strong></div>
          </div>

          <div className="card">
            <div className="card-header main-header">
              <div><h2>{activeAssessment.name}</h2><p>Cloud-backed assessment record with Google/Microsoft SSO, evidence uploads, and PDF export.</p></div>
              <div className="button-row">
                <button className="btn btn-outline" onClick={() => saveCurrent()}>{working ? "Saving..." : "Save to Cloud"}</button>
                <button className="btn btn-outline" onClick={() => saveCurrent("Finalized")}>Finalize</button>
                <button className="btn btn-primary" onClick={() => exportAssessmentPdf(activeAssessment)}>Export PDF</button>
              </div>
            </div>

            <div className="card-body">
              <div className="form-grid">
                <div><label>Assessment Name</label><input value={activeAssessment.name} onChange={(e) => updateAssessment((a) => ({ ...a, name: e.target.value }))} /></div>
                <div><label>School Name</label><input value={activeAssessment.school_name} onChange={(e) => updateAssessment((a) => ({ ...a, school_name: e.target.value }))} /></div>
                <div><label>District</label><input value={activeAssessment.district} onChange={(e) => updateAssessment((a) => ({ ...a, district: e.target.value }))} /></div>
                <div><label>Address</label><input value={activeAssessment.address} onChange={(e) => updateAssessment((a) => ({ ...a, address: e.target.value }))} /></div>
                <div><label>Principal</label><input value={activeAssessment.principal} onChange={(e) => updateAssessment((a) => ({ ...a, principal: e.target.value }))} /></div>
                <div><label>Assessor</label><input value={activeAssessment.assessor} onChange={(e) => updateAssessment((a) => ({ ...a, assessor: e.target.value }))} /></div>
              </div>

              <div className="form-grid">
                <div><label>Executive Summary</label><textarea rows="4" value={activeAssessment.summary} onChange={(e) => updateAssessment((a) => ({ ...a, summary: e.target.value }))} /></div>
                <div><label>Priority Actions</label><textarea rows="4" value={activeAssessment.priority_actions} onChange={(e) => updateAssessment((a) => ({ ...a, priority_actions: e.target.value }))} /></div>
              </div>

              <SectionEditor title="Inside the School" items={activeAssessment.insideItems} area="inside" onItemChange={onItemChange} onCaptureGps={onCaptureGps} onUploadFiles={onUploadFiles} onDeleteFile={onDeleteFile} />
              <SectionEditor title="Outside the School" items={activeAssessment.outsideItems} area="outside" onItemChange={onItemChange} onCaptureGps={onCaptureGps} onUploadFiles={onUploadFiles} onDeleteFile={onDeleteFile} />
              <ReportView assessment={activeAssessment} />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
