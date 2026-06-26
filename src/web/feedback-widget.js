(function () {
	"use strict";

	if (typeof window === "undefined" || typeof document === "undefined") return;

	var script = document.currentScript || document.querySelector("script[data-campaign]");
	var campaign = script ? script.getAttribute("data-campaign") || "" : "";
	var token = script ? script.getAttribute("data-token") || "" : "";
	var endpoint = "/api/feedback/items";
	try {
		if (script && script.src) endpoint = new URL(endpoint, script.src).toString();
	} catch (err) {}
	var identity = {};
	var root;
	var shadow;
	var lastTrigger;
	var canvas;
	var context;
	var drawing = false;
	var lastPoint = null;

	function assign(target, source) {
		if (!source || typeof source !== "object") return target;
		Object.keys(source).forEach(function (key) {
			var value = source[key];
			if (value === null || value === undefined) return;
			if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") target[key] = value;
		});
		return target;
	}

	var api = window.FeedbackLoop && typeof window.FeedbackLoop === "object" ? window.FeedbackLoop : {};
	api.identify = function (details) {
		assign(identity, details);
		return api;
	};
	window.FeedbackLoop = api;

	function el(name, attrs, text) {
		var node = document.createElement(name);
		if (attrs) {
			Object.keys(attrs).forEach(function (key) {
				if (key === "className") node.className = attrs[key];
				else if (key === "htmlFor") node.htmlFor = attrs[key];
				else node.setAttribute(key, attrs[key]);
			});
		}
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function mount() {
		if (root) return;
		root = el("div", { id: "feedback-loop-widget" });
		shadow = root.attachShadow ? root.attachShadow({ mode: "open" }) : root;
		shadow.appendChild(style());
		shadow.appendChild(button());
		document.body.appendChild(root);
	}

	function style() {
		var css = el("style");
		css.textContent = ":host{all:initial;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.fl-button{position:fixed;right:18px;bottom:18px;z-index:2147483646;min-width:44px;min-height:44px;border:0;border-radius:999px;background:#111827;color:#fff;font:600 14px/1 system-ui,sans-serif;padding:14px 18px;box-shadow:0 12px 30px rgba(15,23,42,.24);cursor:pointer}.fl-button:hover{background:#1f2937}.fl-button:focus-visible,.fl-close:focus-visible,.fl-submit:focus-visible,.fl-cancel:focus-visible,.fl-field:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}.fl-backdrop{position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.42);display:flex;align-items:flex-end;justify-content:center;padding:16px}.fl-panel{box-sizing:border-box;width:min(560px,100%);max-height:min(760px,calc(100vh - 32px));overflow:auto;border-radius:18px;background:#fff;color:#111827;box-shadow:0 24px 80px rgba(15,23,42,.32);padding:18px}.fl-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}.fl-title{font:700 18px/1.25 system-ui,sans-serif;margin:0}.fl-help{font:400 13px/1.4 system-ui,sans-serif;color:#4b5563;margin:4px 0 0}.fl-close{min-width:40px;min-height:40px;border:0;border-radius:999px;background:#f3f4f6;color:#111827;cursor:pointer;font-size:22px;line-height:1}.fl-form{display:grid;gap:12px}.fl-row{display:grid;gap:6px}.fl-label{font:600 13px/1.2 system-ui,sans-serif;color:#111827}.fl-field{box-sizing:border-box;width:100%;border:1px solid #d1d5db;border-radius:10px;background:#fff;color:#111827;font:400 14px/1.4 system-ui,sans-serif;padding:10px 12px}.fl-field[aria-invalid=true]{border-color:#dc2626}.fl-area{min-height:96px;resize:vertical}.fl-shot{display:grid;gap:8px}.fl-shot canvas{box-sizing:border-box;width:100%;height:auto;border:1px solid #d1d5db;border-radius:12px;touch-action:none;background:#f9fafb}.fl-note{font:400 12px/1.4 system-ui,sans-serif;color:#4b5563;margin:0}.fl-error{font:600 13px/1.4 system-ui,sans-serif;color:#b91c1c;margin:0}.fl-success{font:600 13px/1.4 system-ui,sans-serif;color:#047857;margin:0}.fl-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}.fl-submit,.fl-cancel{min-height:40px;border-radius:10px;font:700 14px/1 system-ui,sans-serif;padding:0 14px;cursor:pointer}.fl-submit{border:0;background:#111827;color:#fff}.fl-submit[disabled]{cursor:wait;opacity:.7}.fl-cancel{border:1px solid #d1d5db;background:#fff;color:#111827}@media (min-width:640px){.fl-backdrop{align-items:center}}@media (prefers-color-scheme:dark){.fl-panel{background:#111827;color:#f9fafb}.fl-title,.fl-label{color:#f9fafb}.fl-help,.fl-note{color:#d1d5db}.fl-field,.fl-cancel{background:#1f2937;color:#f9fafb;border-color:#4b5563}.fl-close{background:#1f2937;color:#f9fafb}.fl-shot canvas{background:#0f172a;border-color:#4b5563}}";
		return css;
	}

	function button() {
		var btn = el("button", { type: "button", className: "fl-button", "aria-label": "Open feedback form" }, "Feedback");
		btn.addEventListener("click", function () {
			lastTrigger = btn;
			openPanel();
		});
		return btn;
	}

	function openPanel() {
		var backdrop = el("div", { className: "fl-backdrop" });
		var panel = el("section", { className: "fl-panel", role: "dialog", "aria-modal": "true", "aria-labelledby": "fl-heading" });
		var head = el("div", { className: "fl-head" });
		var copy = el("div");
		copy.appendChild(el("h2", { id: "fl-heading", className: "fl-title" }, "Send feedback"));
		copy.appendChild(el("p", { className: "fl-help" }, "Capture the issue, mark it up, and tell us what happened."));
		var close = el("button", { type: "button", className: "fl-close", "aria-label": "Close feedback form" }, "×");
		head.appendChild(copy);
		head.appendChild(close);
		panel.appendChild(head);

		var form = el("form", { className: "fl-form" });
		var error = el("p", { className: "fl-error", role: "alert", hidden: "" });
		var success = el("p", { className: "fl-success", role: "status", hidden: "" });
		var shot = el("div", { className: "fl-shot" });
		var shotNote = el("p", { className: "fl-note" }, "Trying to capture your screen. You can still send text-only feedback.");
		shot.appendChild(shotNote);
		form.appendChild(field("kind", "Kind", kindSelect()));
		form.appendChild(field("title", "Title", input("title", "text", "Short summary", true)));
		form.appendChild(field("description", "Description", textarea()));
		form.appendChild(shot);
		form.appendChild(error);
		form.appendChild(success);
		var actions = el("div", { className: "fl-actions" });
		var cancel = el("button", { type: "button", className: "fl-cancel" }, "Cancel");
		var submit = el("button", { type: "submit", className: "fl-submit" }, "Send feedback");
		actions.appendChild(cancel);
		actions.appendChild(submit);
		form.appendChild(actions);
		panel.appendChild(form);
		backdrop.appendChild(panel);
		shadow.appendChild(backdrop);

		function closePanel() {
			backdrop.remove();
			canvas = null;
			context = null;
			if (lastTrigger && lastTrigger.focus) lastTrigger.focus();
		}

		close.addEventListener("click", closePanel);
		cancel.addEventListener("click", closePanel);
		backdrop.addEventListener("click", function (event) {
			if (event.target === backdrop) closePanel();
		});
		backdrop.addEventListener("keydown", function (event) {
			if (event.key === "Escape") closePanel();
		});
		form.addEventListener("submit", function (event) {
			event.preventDefault();
			submitFeedback(form, submit, error, success, closePanel);
		});
		var title = form.querySelector("#fl-title");
		if (title && title.focus) title.focus();
		captureFrame(shot, shotNote);
	}

	function field(id, label, control) {
		var row = el("div", { className: "fl-row" });
		row.appendChild(el("label", { className: "fl-label", htmlFor: "fl-" + id }, label));
		row.appendChild(control);
		return row;
	}

	function input(id, type, placeholder, required) {
		var attrs = { id: "fl-" + id, name: id, type: type, className: "fl-field", autocomplete: "off", placeholder: placeholder, maxlength: "160" };
		if (required) attrs.required = "";
		return el("input", attrs);
	}

	function textarea() {
		return el("textarea", { id: "fl-description", name: "description", className: "fl-field fl-area", required: "", maxlength: "5000", placeholder: "What happened? What did you expect?" });
	}

	function kindSelect() {
		var select = el("select", { id: "fl-kind", name: "kind", className: "fl-field" });
		[["bug", "Bug"], ["friction", "Friction"], ["feature", "Feature request"]].forEach(function (item) {
			select.appendChild(el("option", { value: item[0] }, item[1]));
		});
		return select;
	}

	async function captureFrame(shot, note) {
		if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
			note.textContent = "Screen capture is not available here. Text-only feedback is ready.";
			return;
		}
		var stream;
		try {
			stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
			var video = document.createElement("video");
			video.srcObject = stream;
			video.muted = true;
			video.playsInline = true;
			await video.play();
			if (!video.videoWidth) {
				await new Promise(function (resolve) {
					video.addEventListener("loadedmetadata", resolve, { once: true });
					setTimeout(resolve, 500);
				});
			}
			var width = video.videoWidth || 1280;
			var height = video.videoHeight || 720;
			var maxWidth = 1200;
			var scale = width > maxWidth ? maxWidth / width : 1;
			canvas = el("canvas");
			canvas.width = Math.round(width * scale);
			canvas.height = Math.round(height * scale);
			context = canvas.getContext("2d");
			context.drawImage(video, 0, 0, canvas.width, canvas.height);
			note.textContent = "Draw on the screenshot if it helps explain the issue.";
			shot.appendChild(canvas);
			wireDrawing(canvas);
		} catch (err) {
			note.textContent = "Screen capture was skipped. Text-only feedback is ready.";
		} finally {
			if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
		}
	}

	function wireDrawing(target) {
		target.addEventListener("pointerdown", function (event) {
			drawing = true;
			lastPoint = point(target, event);
			target.setPointerCapture(event.pointerId);
		});
		target.addEventListener("pointermove", function (event) {
			if (!drawing || !context || !lastPoint) return;
			var next = point(target, event);
			context.strokeStyle = "#ef4444";
			context.lineWidth = 5;
			context.lineCap = "round";
			context.lineJoin = "round";
			context.beginPath();
			context.moveTo(lastPoint.x, lastPoint.y);
			context.lineTo(next.x, next.y);
			context.stroke();
			lastPoint = next;
		});
		["pointerup", "pointercancel", "pointerleave"].forEach(function (name) {
			target.addEventListener(name, function () {
				drawing = false;
				lastPoint = null;
			});
		});
	}

	function point(target, event) {
		var rect = target.getBoundingClientRect();
		return { x: (event.clientX - rect.left) * (target.width / rect.width), y: (event.clientY - rect.top) * (target.height / rect.height) };
	}

	async function submitFeedback(form, submit, error, success, closePanel) {
		error.hidden = true;
		success.hidden = true;
		if (!campaign || !token) {
			showError(error, "Feedback is not configured for this page.");
			return;
		}
		var formData = new FormData(form);
		var metadata = assign({
			url: window.location.href,
			path: window.location.pathname,
			pageTitle: document.title || "",
			browser: navigator.userAgent || "",
			viewport: window.innerWidth + "x" + window.innerHeight
		}, identity);
		var payload = {
			campaignId: campaign,
			token: token,
			kind: String(formData.get("kind") || "bug"),
			title: String(formData.get("title") || "").trim(),
			description: String(formData.get("description") || "").trim(),
			metadata: metadata,
			screenshotDataUrl: canvas ? canvas.toDataURL("image/png") : undefined
		};
		if (!payload.title || !payload.description) {
			showError(error, "Add a title and description before sending.");
			return;
		}
		submit.disabled = true;
		submit.setAttribute("aria-busy", "true");
		submit.textContent = "Sending…";
		try {
			var response = await fetch(endpoint, {
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload)
			});
			if (!response.ok) throw new Error("Request failed");
			success.hidden = false;
			success.textContent = "Thanks — feedback sent.";
			form.reset();
			setTimeout(closePanel, 900);
		} catch (err) {
			showError(error, "Could not send feedback. Please try again.");
		} finally {
			submit.disabled = false;
			submit.removeAttribute("aria-busy");
			submit.textContent = "Send feedback";
		}
	}

	function showError(node, message) {
		node.hidden = false;
		node.textContent = message;
	}

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
	else mount();
})();
