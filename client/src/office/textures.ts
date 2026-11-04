import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from "three";
import type { AgentStatus } from "../../../shared/events.ts";
import type { Scheme } from "./palette.ts";
import { STATUS_COLOR, STATUSES } from "./palette.ts";

// Textures are drawn in code, so the page needs no image files.

const W = 256;
const H = 160;

function draw(paint: (g: CanvasRenderingContext2D) => void): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d");
  if (g) paint(g);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** What each monitor shows. The pattern differs per status, so it can be read even without colour. */
export function makeScreenTextures(scheme: Scheme): Record<AgentStatus, CanvasTexture> {
  const out = {} as Record<AgentStatus, CanvasTexture>;
  for (const status of STATUSES) {
    const accent = STATUS_COLOR[scheme][status];
    out[status] = draw((g) => {
      g.fillStyle = "#0F151C";
      g.fillRect(0, 0, W, H);
      g.fillStyle = accent;
      g.strokeStyle = accent;
      g.lineWidth = 12;
      g.lineCap = "round";
      switch (status) {
        case "working": // rows of lines that scroll
          for (let y = 12, i = 0; y < H; y += 20, i++) g.fillRect(16, y, 60 + ((i * 53) % 150), 9);
          break;
        case "idle": // dim, with a cursor
          g.globalAlpha = 0.55;
          g.fillRect(24, 60, 14, 38);
          g.fillRect(24, 118, 70, 8);
          break;
        case "waiting": // three dots
          for (const x of [78, 128, 178]) {
            g.beginPath();
            g.arc(x, 80, 14, 0, Math.PI * 2);
            g.fill();
          }
          break;
        case "done": // a tick
          g.beginPath();
          g.moveTo(70, 84);
          g.lineTo(112, 122);
          g.lineTo(188, 40);
          g.stroke();
          break;
        case "stopped": // black with a small square
          g.fillRect(104, 56, 48, 48);
          break;
        case "error": // a cross
          g.beginPath();
          g.moveTo(88, 36);
          g.lineTo(168, 124);
          g.moveTo(168, 36);
          g.lineTo(88, 124);
          g.stroke();
          break;
        case "detached": // "no signal" bars
          g.globalAlpha = 0.8;
          for (let x = -H; x < W; x += 36) {
            g.beginPath();
            g.moveTo(x, H);
            g.lineTo(x + H, 0);
            g.lineWidth = 10;
            g.stroke();
          }
          break;
      }
    });
  }
  // The lines on a working screen are drawn to repeat vertically, so the texture can scroll.
  out.working.wrapT = RepeatWrapping;
  return out;
}

/** A soft round shadow, drawn once and used under every desk. */
export function makeShadowTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const g = canvas.getContext("2d");
  if (g) {
    const gradient = g.createRadialGradient(64, 64, 6, 64, 64, 62);
    gradient.addColorStop(0, "rgba(0,0,0,0.55)");
    gradient.addColorStop(0.6, "rgba(0,0,0,0.28)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gradient;
    g.fillRect(0, 0, 128, 128);
  }
  return new CanvasTexture(canvas);
}
