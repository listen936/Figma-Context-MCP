import { type SimplifiedLayout, buildSimplifiedLayout } from "~/transformers/layout.js";
import type {
  GetFileNodesResponse,
  Node as FigmaDocumentNode,
  Paint,
  Vector,
  GetFileResponse,
  Component,
  ComponentSet,
  ComponentPropertyType,
} from "@figma/rest-api-spec";
import { hasValue, isRectangleCornerRadii, isTruthy } from "~/utils/identity.js";
import {
  removeEmptyKeys,
  generateVarId,
  type StyleId,
  parsePaint,
  isVisible,
  getComponentData,
} from "~/utils/common.js";
import { buildSimplifiedStrokes, type SimplifiedStroke } from "~/transformers/style.js";
import { buildSimplifiedEffects, type SimplifiedEffects } from "~/transformers/effects.js";
/**
 * TODO ITEMS
 *
 * - Improve layout handling—translate from Figma vocabulary to CSS
 * - Pull image fills/vectors out to top level for better AI visibility
 *   ? Implement vector parents again for proper downloads
 * ? Look up existing styles in new MCP endpoint—Figma supports individual lookups without enterprise /v1/styles/:key
 * ? Parse out and save .cursor/rules/design-tokens file on command
 **/

// -------------------- SIMPLIFIED STRUCTURES --------------------

export type TextStyle = Partial<{
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  lineHeight: string;
  letterSpacing: string;
  textCase: string;
  textAlignHorizontal: string;
  textAlignVertical: string;
}>;
export type StrokeWeights = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};
type StyleTypes =
  | TextStyle
  | SimplifiedFill[]
  | SimplifiedLayout
  | SimplifiedStroke
  | SimplifiedEffects
  | string;
type GlobalVars = {
  styles: Record<StyleId, StyleTypes>;
};
export interface SimplifiedDesign {
  name: string;
  lastModified: string;
  thumbnailUrl: string;
  nodes: SimplifiedNode[];
  globalVars: GlobalVars;
}
export interface ComponentProperties {
  name: string;
  value: string;
  type: ComponentPropertyType;
}
export interface SimplifiedNode {
  id: string;
  name: string;
  type: string; // e.g. FRAME, TEXT, INSTANCE, RECTANGLE, etc.
  // geometry
  boundingBox?: BoundingBox;
  // text
  text?: string;
  textStyle?: string;
  // appearance
  fills?: string;
  styles?: string;
  strokes?: string;
  effects?: string;
  opacity?: number;
  borderRadius?: string;
  componentName?: string; // type:INSTANCE 是icon 组件使用 icon name
  // layout & alignment
  layout?: string;
  // backgroundColor?: ColorValue; // Deprecated by Figma API
  // for rect-specific strokes, etc.
  // children
  children?: SimplifiedNode[];
  componentProperties?: ComponentProperties[];
  remote?: boolean; // 是否远程组件
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CSSRGBAColor = `rgba(${number}, ${number}, ${number}, ${number})`;
export type CSSHexColor = `#${string}`;
export type SimplifiedFill =
  | {
      type?: Paint["type"];
      hex?: string;
      rgba?: string;
      opacity?: number;
      imageRef?: string;
      scaleMode?: string;
      gradientHandlePositions?: Vector[];
      gradientStops?: {
        position: number;
        color: ColorValue | string;
      }[];
    }
  | CSSRGBAColor
  | CSSHexColor;

export interface ColorValue {
  hex: string;
  opacity: number;
}

// ---------------------- PARSING ----------------------
export function parseFigmaResponse(data: GetFileResponse | GetFileNodesResponse): SimplifiedDesign {
  const { name, lastModified, thumbnailUrl } = data;
  let nodes: FigmaDocumentNode[];
  let components: Record<string, Component> = {};
  let componentSets: Record<string, ComponentSet> = {};
  if ("document" in data) {
    nodes = Object.values(data.document.children);
  } else {
    nodes = [];
    for (const node of Object.values(data.nodes)) {
      nodes.push(node.document);
      if (node.components) {
        Object.assign(components, node.components);
      }
      if (node.componentSets) {
        Object.assign(componentSets, node.componentSets);
      }
    }
  }

  let globalVars: GlobalVars = {
    styles: {},
  };
  const simplifiedNodes: SimplifiedNode[] = nodes
    .filter(isVisible)
    .map((n) => parseNode(globalVars, n, undefined, components,componentSets))
    .filter((child) => child !== null && child !== undefined);

  return {
    name,
    lastModified,
    thumbnailUrl: thumbnailUrl || "",
    nodes: simplifiedNodes,
    globalVars,
  };
}

// Helper function to find node by ID
const findNodeById = (id: string, nodes: SimplifiedNode[]): SimplifiedNode | undefined => {
  for (const node of nodes) {
    if (node?.id === id) {
      return node;
    }

    if (node?.children && node.children.length > 0) {
      const foundInChildren = findNodeById(id, node.children);
      if (foundInChildren) {
        return foundInChildren;
      }
    }
  }

  return undefined;
};

/**
 * Find or create global variables
 * @param globalVars - Global variables object
 * @param value - Value to store
 * @param prefix - Variable ID prefix
 * @returns Variable ID
 */
function findOrCreateVar(globalVars: GlobalVars, value: any, prefix: string): StyleId {
  // Check if the same value already exists
  const [existingVarId] =
    Object.entries(globalVars.styles).find(
      ([_, existingValue]) => JSON.stringify(existingValue) === JSON.stringify(value),
    ) ?? [];

  if (existingVarId) {
    return existingVarId as StyleId;
  }

  // Create a new variable if it doesn't exist
  const varId = generateVarId(prefix);
  globalVars.styles[varId] = value;
  return varId;
}

function parseNode(
  globalVars: GlobalVars,
  n: FigmaDocumentNode,
  parent?: FigmaDocumentNode,
  components?: Record<string, Component>, // 修改类型为普通对象
  componentSets?: Record<string, ComponentSet>,
): SimplifiedNode | null {
  const { id, name, type } = n;

  const simplified: SimplifiedNode = {
    id,
    name,
    type,
  };

  // text
  if (hasValue("style", n) && Object.keys(n.style).length) {
    const style = n.style;
    const textStyle = {
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      fontSize: style.fontSize,
      lineHeight:`${style.lineHeightPx}px`,
      letterSpacing:`${style.letterSpacing}px`,
      textCase: style.textCase,
      textAlignHorizontal: style.textAlignHorizontal,
      textAlignVertical: style.textAlignVertical,
    };
    simplified.textStyle = findOrCreateVar(globalVars, textStyle, "style");
  }

  // fills & strokes
  if (hasValue("fills", n) && Array.isArray(n.fills) && n.fills.length) {
    // const fills = simplifyFills(n.fills.map(parsePaint));
    const fills = n.fills.map(parsePaint);
    simplified.fills = findOrCreateVar(globalVars, fills, "fill");
  }

  const strokes = buildSimplifiedStrokes(n);
  if (strokes.colors.length) {
    simplified.strokes = findOrCreateVar(globalVars, strokes, "stroke");
  }

  const effects = buildSimplifiedEffects(n);
  if (Object.keys(effects).length) {
    simplified.effects = findOrCreateVar(globalVars, effects, "effect");
  }

  // Process layout
  const layout = buildSimplifiedLayout(n, parent);
  if (Object.keys(layout).length > 1) {
    simplified.layout = findOrCreateVar(globalVars, layout, "layout");
  }

  // Keep other simple properties directly
  if (hasValue("characters", n, isTruthy)) {
    simplified.text = n.characters;
  }

  // border/corner

  // opacity
  if (hasValue("opacity", n) && typeof n.opacity === "number" && n.opacity !== 1) {
    simplified.opacity = n.opacity;
  }

  if (hasValue("cornerRadius", n) && typeof n.cornerRadius === "number") {
    simplified.borderRadius = `${n.cornerRadius}px`;
  }
  if (hasValue("rectangleCornerRadii", n, isRectangleCornerRadii)) {
    simplified.borderRadius = `${n.rectangleCornerRadii[0]}px ${n.rectangleCornerRadii[1]}px ${n.rectangleCornerRadii[2]}px ${n.rectangleCornerRadii[3]}px`;
  }

  if (type === "INSTANCE" && hasValue("componentId", n)) {
    // 组件类型的节点没有必要再给出children
    const componentId = n.componentId;
    if (components?.[componentId]) {
      const {name,remote}= getComponentData(components[componentId], componentSets!); 
      simplified.componentName = name;
      simplified.remote = remote;
    }
    if (hasValue("componentProperties", n)) {
      simplified.componentProperties = Object.entries(n?.componentProperties ?? {}).map(([name, { value, type }]) => ({
        name,
        value: value.toString(),
        type,
      }));
    }
  } else {
    // Recursively process child nodes
    if (hasValue("children", n) && n.children.length > 0) {
      let children = n.children
        .filter(isVisible)
        .map((child) => parseNode(globalVars, child, n, components,componentSets))
        .filter((child) => child !== null && child !== undefined);
      if (children.length) {
        simplified.children = children;
      }
    }
  }

  // Convert VECTOR to IMAGE
  if (type === "VECTOR") {
    simplified.type = "IMAGE-SVG";
  }

  return removeEmptyKeys(simplified);
}
