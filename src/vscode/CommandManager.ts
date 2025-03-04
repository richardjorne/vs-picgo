import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { Editor } from './Editor'
import { PicgoAPI } from './PicgoAPI'
import { PicgoAddon } from './PicgoAddon'
import { showError, showInfo, showWarning } from './utils'

export class CommandManager {
  static commandManager: CommandManager = new CommandManager()

  async uploadCommand(input?: string[]) {
    const pluginName = 'vspicgo'
    PicgoAPI.picgoAPI.setCurrentPluginName(pluginName)
    const [id, plugin] = PicgoAddon.picgoAddon.beforeUploadPlugin()
    PicgoAPI.picgoAPI.helper.beforeUploadPlugins.register(id, plugin)

    const output = await PicgoAPI.picgoAPI.upload(input)
    PicgoAPI.picgoAPI.helper.beforeUploadPlugins.unregister(pluginName)

    // error has been handled in picgoAPI.upload
    if (!output) return

    const outputString = PicgoAddon.picgoAddon.outputToString(output)

    vscode.env.clipboard.writeText(outputString)
    await Editor.writeToEditor(outputString)
    return outputString
  }

  async silentUploadCommand(input?: string[]) {
    const pluginName = 'vspicgo'
    PicgoAPI.picgoAPI.setCurrentPluginName(pluginName)
    const [id, plugin] = PicgoAddon.picgoAddon.beforeUploadPlugin()
    PicgoAPI.picgoAPI.helper.beforeUploadPlugins.register(id, plugin)

    const output = await PicgoAPI.picgoAPI.upload(input)
    PicgoAPI.picgoAPI.helper.beforeUploadPlugins.unregister(pluginName)

    // error has been handled in picgoAPI.upload
    if (!output) return

    return PicgoAddon.picgoAddon.outputToURLs(output)
  }

  async generateUploadedImageVersionMarkdown(sameFile: boolean = false) {
    // Get current editor
    const editor = Editor.editor
    if (!editor) {
      showError('No active editor')
      return
    }

    // Get document text and path
    const document = editor.document

    let newEditor: vscode.TextEditor
    let newDocument: vscode.TextDocument

    if (sameFile) {
      // Use existing document and editor
      newEditor = editor
      newDocument = document
    } else {
      // Original file handling logic
      const originalFilePath = document.uri.fsPath
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
      if (!workspaceFolder) {
        showError('No workspace folder found')
        return
      }

      const originalDir = path.dirname(originalFilePath)
      const originalFileName = path.basename(
        originalFilePath,
        path.extname(originalFilePath)
      )
      const fileExt = path.extname(originalFilePath)

      // Check setting for upload version folder
      const useUploadFolder = vscode.workspace
        .getConfiguration('picgo')
        .get('useUploadVersionFolder', false)

      // Determine target directory and create if needed
      let targetDir
      if (useUploadFolder) {
        // Get relative path from workspace root to the original file's directory
        const relativeDir = path.relative(
          workspaceFolder.uri.fsPath,
          originalDir
        )
        // Create target path in uploadedVersion folder
        targetDir = path.join(
          workspaceFolder.uri.fsPath,
          'uploadedVersion',
          relativeDir
        )
        // Create all necessary directories
        fs.mkdirSync(targetDir, { recursive: true })
      } else {
        targetDir = originalDir
      }

      // Create new file path
      const newFileName = `${originalFileName}${
        useUploadFolder ? '' : '_uploadedVersion'
      }${fileExt}`
      const newFilePath = path.join(targetDir, newFileName)

      // Copy original file content
      fs.copyFileSync(originalFilePath, newFilePath)

      // Open the new file
      newDocument = await vscode.workspace.openTextDocument(newFilePath)
      newEditor = await vscode.window.showTextDocument(newDocument)
    }

    // Get text from new document
    const text = newDocument.getText()

    // Match various markdown image syntax:
    // 1. Standard markdown: ![alt](url) or ![alt](url "title")
    // 2. HTML: <img src="url" ...>
    // 3. Obsidian: ![[filename]]
    // 4. YAML-style: cover: path/to/image or image: path/to/image
    const mdImageRegex = /!\[([^\]]*)\]\((?:<([^>]+)>|([^)\s]+))\s*(.*)?\)|<img[^>]+src=["']([^"']+)["'][^>]*>|!\[\[([^\]]+)\]\]|((?:cover|image):\s*([^\s\n]+))/g
    let match
    let hasLocalImage = false
    const replacements: Array<{ original: string; replacement: string }> = []

    // Add a cache to store path -> url mappings
    const pathToUrlCache: Map<string, string> = new Map()
    // Store the original matched path to preserve the format
    const originalMatchToUrl: Map<string, string> = new Map()

    // Iterate through all matches
    while ((match = mdImageRegex.exec(text)) !== null) {
      // Get image URL - Extract according to different formats
      let imgUrl = ''

      if (match[2]) {
        // Standard markdown
        imgUrl = match[2]
      } else if (match[3]) {
        // Standard markdown
        imgUrl = match[3]
      } else if (match[4]) {
        // HTML format
        imgUrl = match[4]
      } else if (match[5]) {
        // Obsidian format
        imgUrl = match[5]
      } else if (match[8]) {
        // YAML-style format (cover: or image:)
        imgUrl = match[8]
      }

      if (!imgUrl) continue

      // Check whether it's a local path or a URL
      if (!imgUrl.startsWith('http') && !imgUrl.startsWith('data:')) {
        hasLocalImage = true

        // Handle path
        let absolutePath = imgUrl
        if (!path.isAbsolute(imgUrl)) {
          if (match[5]) {
            // Obsidian syntax
            const attachmentFolders = [
              path.join(path.dirname(document.uri.fsPath), 'attachments'),
              path.join(path.dirname(document.uri.fsPath), 'assets'),
              path.dirname(document.uri.fsPath)
            ]

            // search for the image in the attachment folders (possible when in Obsidian)
            for (const folder of attachmentFolders) {
              const testPath = path.join(folder, imgUrl)
              if (fs.existsSync(testPath)) {
                absolutePath = testPath
                break
              }
            }
          } else {
            absolutePath = path.resolve(
              path.dirname(document.uri.fsPath),
              imgUrl
            )
          }
        }

        if (fs.existsSync(absolutePath)) {
          let newUrl: string

          // Check if we've already uploaded this image
          if (pathToUrlCache.has(absolutePath)) {
            newUrl = pathToUrlCache.get(absolutePath) ?? ''
          } else {
            // Upload image and cache the result
            const newUrls = await this.silentUploadCommand([absolutePath])
            if (newUrls && newUrls.length > 0) {
              newUrl = newUrls[0]
              pathToUrlCache.set(absolutePath, newUrl)
              // Also store the original matched path
              originalMatchToUrl.set(imgUrl, newUrl)
            } else {
              continue // Skip if upload failed
            }
          }

          let replacement = newUrl
          if (match[2]) {
            // Markdown format
            const originalStr = match[0]
            replacement = originalStr.replace(match[2], newUrl)
          } else if (match[3]) {
            // Markdown format
            const originalStr = match[0]
            replacement = originalStr.replace(match[3], newUrl)
          } else if (match[4]) {
            // HTML format
            const originalStr = match[0]
            replacement = originalStr.replace(match[4], newUrl)
          } else if (match[5]) {
            // Obsidian format
            const originalStr = match[0]
            replacement = originalStr.replace(match[5], newUrl)
          } else if (match[8]) {
            // YAML-style format
            const originalStr = match[0]
            replacement = originalStr.replace(match[8], newUrl)
          }
          replacements.push({
            original: match[0],
            replacement: replacement
          })
        } else {
          showError(`Local image not found: ${absolutePath}`)
        }
      }
    }

    if (!hasLocalImage) {
      showWarning('No local images found in current document')
      return
    }

    // Replace all local image links in the new file
    newEditor.edit((editBuilder) => {
      // First try to replace using the original matched paths
      for (const [originalPath, remoteUrl] of originalMatchToUrl.entries()) {
        const fileText = newDocument.getText()
        let startIndex = 0
        while (true) {
          const index = fileText.indexOf(originalPath, startIndex)
          if (index === -1) break

          const startPos = newDocument.positionAt(index)
          const endPos = newDocument.positionAt(index + originalPath.length)
          editBuilder.replace(new vscode.Range(startPos, endPos), remoteUrl)
          showInfo(
            `Replaced local path ${originalPath} with remote URL ${remoteUrl}`
          )
          startIndex = index + 1
        }
      }
    })
  }

  async uploadImageFromClipboard() {
    this.uploadCommand()
  }

  async uploadImageFromExplorer() {
    const result = await vscode.window.showOpenDialog({
      filters: {
        Images: [
          'png',
          'jpg',
          'jpeg',
          'webp',
          'gif',
          'bmp',
          'tiff',
          'ico',
          'svg'
        ]
      },
      canSelectMany: true
    })

    if (result != null) {
      const input = result.map((item) => item.fsPath)
      this.uploadCommand(input)
    }
  }

  async uploadImageFromInputBox() {
    let result = await vscode.window.showInputBox({
      placeHolder: 'Please input an image location path'
    })
    // check if `result` is a path of image file
    const imageReg = /\.(png|jpg|jpeg|webp|gif|bmp|tiff|ico|svg)$/
    if (result && imageReg.test(result)) {
      result = path.isAbsolute(result)
        ? result
        : path.join(Editor.editor?.document.uri.fsPath ?? '', '../', result)
      if (fs.existsSync(result)) {
        return await this.uploadCommand([result])
      } else {
        showError('No such image.')
      }
    } else {
      showError('No such image.')
    }
  }
}
