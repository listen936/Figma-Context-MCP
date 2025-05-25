import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FigmaService, type FigmaAuthOptions } from "./services/figma.js";
import type { SimplifiedDesign } from "./services/simplify-node-response.js";
import yaml from "js-yaml";
import { Logger } from "./utils/logger.js";

const serverInfo = {
  name: "Figma MCP Server",
  version: "0.2.1",
};

function createServer(
  authOptions: FigmaAuthOptions,
  { isHTTP = false }: { isHTTP?: boolean } = {},
) {
  const server = new McpServer(serverInfo);
  // const figmaService = new FigmaService(figmaApiKey);
  const figmaService = new FigmaService(authOptions);
  registerTools(server, figmaService);

  Logger.isHTTP = isHTTP;

  return server;
}

function registerTools(server: McpServer, figmaService: FigmaService): void {
  // Tool to get file information
  server.tool(
    "get_figma_data",
    "获取Figma文件的布局信息，当无法获取节点ID时用于获取整个文件的信息",
      // When the nodeId cannot be obtained, obtain the layout information about the entire Figma file
    {
      fileKey: z
        .string()
        .describe(
          "要获取的Figma文件的key，通常在URL中找到，格式如：figma.com/(file|design)/<fileKey>/..."
            // The key of the Figma file to fetch, often found in a provided URL like figma.com/(file|design)/<fileKey>/...
        ),
      nodeId: z
        .string()
        .optional()
        .describe(
          "要获取的节点ID，通常作为URL参数存在，格式如：node-id=<nodeId>，如果提供了则必须使用"
            // The ID of the node to fetch, often found as URL parameter node-id=<nodeId>, always use if provided
        ),
      depth: z
        .number()
        .optional()
        .describe(
          "OPTIONAL. Do NOT use unless explicitly requested by the user. Controls how many levels deep to traverse the node tree,",
        ),
    },
    async ({ fileKey, nodeId, depth }) => {
      try {
        Logger.log(
          `Fetching ${
            depth ? `${depth} layers deep` : "all layers"
          } of ${nodeId ? `node ${nodeId} from file` : `full file`} ${fileKey}`,
        );

        let file: SimplifiedDesign;
        if (nodeId) {
          file = await figmaService.getNode(fileKey, nodeId, depth);
        } else {
          file = await figmaService.getFile(fileKey, depth);
        }

        Logger.log(`Successfully fetched file: ${file.name}`);
        const { nodes, globalVars, ...metadata } = file;

        const result = {
          metadata,
          nodes,
          globalVars,
        };

        Logger.log("Generating YAML result from file");
        const yamlResult = yaml.dump(result);

        Logger.log("Sending result to client");
        return {
          content: [{ type: "text", text: yamlResult }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        Logger.error(`Error fetching file ${fileKey}:`, message);
        return {
          isError: true,
          content: [{ type: "text", text: `Error fetching file: ${message}` }],
        };
      }
    },
  );

  // TODO: Clean up all image download related code, particularly getImages in Figma service
  // Tool to download images
  server.tool(
    "download_figma_images",
    "根据图像或图标节点的ID下载Figma文件中使用的SVG和PNG图像",
      // Download SVG and PNG images used in a Figma file based on the IDs of image or icon nodes
    {
      fileKey: z.string().describe(
          "包含节点的Figma文件的key"
          // The key of the Figma file containing the node
        ),
      nodes: z
        .object({
          nodeId: z
            .string()
            .describe(
                "要获取的Figma图像节点的ID，格式如：1234:5678"
                // The ID of the Figma image node to fetch, formatted as 1234:5678
              ),
          imageRef: z
            .string()
            .optional()
            .describe(
              "如果节点有imageRef填充，必须包含此变量。下载矢量SVG图像时留空"
                // If a node has an imageRef fill, you must include this variable. Leave blank when downloading Vector SVG images.
            ),
          fileName: z.string().describe(
              "保存获取文件的本地名称"
              // The local name for saving the fetched file
            ),
        })
        .array()
        .describe("The nodes to fetch as images"),
      scale: z
        .number()
        .positive()
        .optional()
        .describe(
          "Export scale for PNG images. Optional, generally 2 is best, though users may specify a different scale.",
        ),
      localPath: z
        .string()
        .describe(
          "项目中存储图像的目录的绝对路径。如果目录不存在，将创建该目录。此路径的格式应尊重您运行的操作系统的目录格式。路径名中也不要使用任何特殊字符转义"
            // The absolute path to the directory where images are stored in the project. If the directory does not exist, it will be created. The format of this path should respect the directory format of the operating system you are running on. Don't use any special character escaping in the path name either.
        ),
    },
    async ({ fileKey, nodes, scale, localPath }) => {
      try {
        const imageFills = nodes.filter(({ imageRef }) => !!imageRef) as {
          nodeId: string;
          imageRef: string;
          fileName: string;
        }[];
        const fillDownloads = figmaService.getImageFills(fileKey, imageFills, localPath);
        const renderRequests = nodes
          .filter(({ imageRef }) => !imageRef)
          .map(({ nodeId, fileName }) => ({
            nodeId,
            fileName,
            fileType: fileName.endsWith(".svg") ? ("svg" as const) : ("png" as const),
          }));

        const renderDownloads = figmaService.getImages(fileKey, renderRequests, localPath, scale);

        const downloads = await Promise.all([fillDownloads, renderDownloads]).then(([f, r]) => [
          ...f,
          ...r,
        ]);

        // If any download fails, return false
        const saveSuccess = !downloads.find((success) => !success);
        return {
          content: [
            {
              type: "text",
              text: saveSuccess
                ? `Success, ${downloads.length} images downloaded: ${downloads.join(", ")}`
                : "Failed",
            },
          ],
        };
      } catch (error) {
        Logger.error(`Error downloading images from file ${fileKey}:`, error);
        return {
          isError: true,
          content: [{ type: "text", text: `Error downloading images: ${error}` }],
        };
      }
    },
  );
}

export { createServer };
