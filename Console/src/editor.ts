/// <reference path="../node_modules/monaco-editor/monaco.d.ts" />

import { remote } from 'electron';

const { Menu, MenuItem, dialog } = remote;

import { MenuUtilities } from './menu_utilities';

// note elsewhere we're trying to be very generic about languages
// in the editor (notwithstanding that we know which languages we
// actually support). this is our language tokenizer/lexer, which 
// is independent of that (there's no native julia support in monaco).

import * as JuliaLanguage from './julia_tokenizer';
import { TabPanel, TabJustify, TabEventType, TabSpec } from './tab_panel';

const Constants = require("../data/constants.json");

import * as path from 'path';
import * as fs from 'fs';
import * as Rx from 'rxjs';

// md for static rendering. FIXME: options, tune
// [adding task lists]

import * as MarkdownIt from 'markdown-it';
import * as MarkdownItTasks from 'markdown-it-task-lists';
const MD = new MarkdownIt().use(MarkdownItTasks); 

// ambient, declared in html. we need this for loading monaco
declare const amd_require: any;

import { Preferences, PreferencesSchema } from './preferences';
const SchemaSchema = require("../data/schemas/schema.schema.json");

interface UncloseRecord {
  id: number;
  position: number;
}

enum DocumentType {
  File = 0,
  LocalStorage
}

export enum EditorEventType {
  Command = 1,
  Information = 2,
  Warning = 3,
  Error = 4
}

export interface EditorEvent {
  type:EditorEventType;
  message?:string;
  data?:any;
}

/**
 * class represents a document in the editor; has content, view state.
 * extended to support static (i.e. rendered) documents, which are 
 * displayed as html.
 * 
 * FIXME: base type, subtypes for rendered/editor documents
 * FIXME: rendered documents should retain source, re-render 
 *        [actually it already does that]
 */
class Document {

  /** label: the file name, generally, or "untitled-x" */
  label_: string;

  /** path to file. null for "new" files that have never been saved. */
  file_path_: string;

  /** editor model */
  model_: monaco.editor.IModel;

  /** preserved state on tab switches */
  view_state_: monaco.editor.ICodeEditorViewState;

  /** flag */
  dirty_ = false;

  /** the last saved version, for comparison to AVID, for dirty check */
  saved_version_ = 0; // last saved version ID

  /** local ID */
  id_: number;

  /** type */
  type_ = DocumentType.File;

  /** rendered: not editable, show rendered content -- md and html? */
  rendered_ = false;

  /** */
  rendered_content_:string;

  /** node for rendered content. not preserved. */
  rendered_content_node_:HTMLElement;

  /** override language (optional) */
  overrideLanguage_: string;

  /** serialize */
  toJSON() {
    return {
      label: this.label_,
      file_path: this.file_path_,
      view_state: this.view_state_,
      dirty: this.dirty_,
      overrideLanguage: this.overrideLanguage_,
      uri: this.model_ ? this.model_.uri : null,
      type: this.type_,
      rendered: this.rendered_,
      saved_version: this.saved_version_,
      alternative_version_id: this.model_ ? this.model_.getAlternativeVersionId() : 0,
      text: this.model_ ? this.model_.getValue() : this.rendered_content_
    }
  }

}

/**
 * 
 */
class EditorStatusBar {

  /** main status bar node */
  private node_: HTMLElement;

  /** text, left side */
  private label_: HTMLElement;

  /** line/col (right side) */
  private position_: HTMLElement;

  /** language (right side) */
  private language_: HTMLElement;

  /** accessor */
  public get node() { return this.node_; }

  /** accessor for content, not node */
  public set label(text) { this.label_.textContent = text; }

  /** accessor for content, not node */
  public set language(text) { this.language_.textContent = text; }

  /** accessor for content, not node: pass [line, col] */
  public set position([line, column]) {
    if (null === line || null === column) {
      this.position_.textContent = "";
    }
    else {
      this.position_.textContent = `${Constants.status.line} ${line}, ${Constants.status.column} ${column}`;
    }
  }

  /** show/hide position, for rendered documents */
  public set show_position(show:boolean){
    this.position_.style.display = show ? "" : "none";
  }
  
  constructor() {

    this.node_ = document.createElement("div");
    this.node_.classList.add("editor-status-bar");

    this.label_ = document.createElement("div");
    this.node_.appendChild(this.label_);

    // this node has flex-grow=1 to push other nodes to left and right
    let spacer = document.createElement("div");
    spacer.classList.add("spacer");
    this.node_.appendChild(spacer);

    this.position_ = document.createElement("div");
    this.node_.appendChild(this.position_);

    this.language_ = document.createElement("div");
    this.node_.appendChild(this.language_);

  }

}

/**
 * class represents an editor; handles its own layout. basically a wrapper
 * for monaco, adding document handling plus any customization we want to do.
 * 
 * monaco doesn't work as a module, so it requires some html markup and 
 * some extra loading, but once that's done we can treat it as a regular 
 * type (using the reference).
 */
export class Editor {

  /** flag for loading, in case we have multiple instances */
  static loaded_ = false;

  /** utility function */
  static UriFromPath(_path) {
    var pathName = path.resolve(_path).replace(/\\/g, '/');
    if (pathName.length > 0 && pathName.charAt(0) !== '/') {
      pathName = '/' + pathName;
    }
    return encodeURI('file://' + pathName);
  }

  /**
   * finish loading monaco
   */
  static LoadMonaco(): Promise<void> {

    if (this.loaded_) return Promise.resolve();

    return new Promise((resolve, reject) => {

      this.loaded_ = true;

      // see monaco electron sample for this

      amd_require.config({
        baseUrl: Editor.UriFromPath(path.join(__dirname, '../node_modules/monaco-editor/min'))
      });
      self['module'] = undefined;
      self['process'].browser = true;

      // this is async
      amd_require(['vs/editor/editor.main'], () => {

        // register additional languages (if any)
        // TODO: abstract this

        let conf = { id: 'julia', extensions: ['.jl', '.julia'] };
        monaco.languages.register(conf);
        monaco.languages.onLanguage(conf.id, () => {
          monaco.languages.setMonarchTokensProvider(conf.id, JuliaLanguage.language);
          monaco.languages.setLanguageConfiguration(conf.id, JuliaLanguage.conf);
        });

        resolve();

      });
    });

  }

  /** status bar instance */
  private status_bar_ = new EditorStatusBar();

  /** editor instance */
  private editor_: monaco.editor.IStandaloneCodeEditor;

  /** tab panel */
  private tabs_: TabPanel;

  /** html element containing editor */
  private container_: HTMLElement;

  /** properties */
  private properties_: any;

  /** list of open documents */
  // private documents_:Document[] = [];

  /** reference */
  private active_document_: Document;

  /** reference */
  private active_tab_: TabSpec;

  /** event source for editor */
  private events_ = new Rx.Subject<EditorEvent>();

  /** accessor */
  public get events(){ return this.events_; } 

  /** 
   * editor options. this also includes options passed to models, 
   * on create. we rely on the API functions to ignore fields they
   * don't use so we can consolidate in a single block.
   */
  private editor_options_: any = {};

  /** 
   * monotonically increment "Untitled-X" documents. by convention starts at 1.
   */
  private untitled_id_generator_ = 1;

  /** 
   * internal document IDs need to be unique, but no other constraints. we 
   * start at > 0 just for aesthetic reasons.
   */
  private document_id_generator = 1000;

  /** 
   * recently closed documents, for unclosing. session only. lifo.
   */
  private closed_tabs_: UncloseRecord[] = [];

  /** 
   * editor node. we only have one editor, we swap documents in and out
   * on tab switching. more efficient.
   */
  private editor_node_:HTMLElement;

  /** 
   * we make some editor configuration changes for supported languages (that
   * we can execute). the renderer process reports which languages it has 
   * loaded. however there may be timing issues where the editor is not yet
   * loaded when we get notified, so in that case we'll temporarily cache 
   * them and update when ready.
   */
  private pending_active_languages_:string[] = [];

  /**
   * builds layout, does any necessary initialization and then instantiates 
   * the editor instance
   * 
   * @param node an element, or a selector we can pass to `querySelector()`.
   */
  constructor(node: string | HTMLElement, properties: any) {

    this.properties_ = properties;

    if (typeof node === "string") this.container_ = document.querySelector(node);
    else this.container_ = node;

    // if we render markdown (or html), then we'll possibly have links.
    // we need to handle these so we don't lose the window.

    // TODO: buttons, script, everything else...

    this.container_.addEventListener("click", e => {
      if(e.srcElement['href']){
        e.stopPropagation();
        e.preventDefault();
        require('electron').shell.openExternal(e.srcElement['href']);
      }
    });
    
    this.container_.classList.add("editor-container");

    let tabs = document.createElement("div");
    tabs.classList.add("editor-tabs");
    this.container_.appendChild(tabs);

    let editor = document.createElement("div");
    editor.classList.add("editor-editor");
    tabs.appendChild(editor);

    this.editor_node_ = editor;

    this.container_.appendChild(this.status_bar_.node);
    this.status_bar_.label = Constants.status.ready;

    this.tabs_ = new TabPanel(tabs);

    this.tabs_.events.filter(event => event.type === TabEventType.deactivate).subscribe(event => {
      this.DeactivateTab(event.tab);
    });

    this.tabs_.events.filter(event => event.type === TabEventType.activate).subscribe(event => {
      this.ActivateTab(event.tab);
    });

    this.tabs_.events.filter(x => x.type === TabEventType.buttonClick).subscribe(event => {
      this.CloseTab(event.tab);
    });

    this.InitEditor(editor);

    MenuUtilities.events.subscribe(event => {
      switch (event.id) {
        case "main.file.open-file":
          this.OpenFile();
          break;
        case "main.file.close-file":
          this.CloseTab(this.active_tab_);
          break;
        case "main.file.save-file":
          this.SaveTab(this.active_tab_);
          break;
        case "main.file.save-file-as":
          this.SaveTab(this.active_tab_, true);
          break;
        case "main.file.new-file":
          this.NewFile();
          break;
        case "main.file.revert-file":
          this.RevertFile();
          break;
        case "main.file.unclose-tab":
          this.UncloseTab();
          break;
        case "main.file.open-recent.open-recent-file":
          this.OpenFile(event.item.data);
          break;

        // prefs

        case "main.view.preferences":
          this.OpenPreferences();
          break;

      }
    });

    MenuUtilities.loaded.filter(x => x).first().subscribe(() => this.UpdateRecentFilesList());

  }

  /*
  private LoadThemes(): Promise<any> {
    return new Promise((resolve, reject) => {
      let dir = path.resolve("data/themes");
      fs.readdir(dir, (err, files) => {
        if (err) console.error(err);
        else {
          let themes = files.filter(x => /\.json$/i.test(x)).map(x => {
            return require(path.join(dir, x));
          });
          themes.forEach(theme => {
            if (theme.id) {
              console.info(theme);
              monaco.editor.defineTheme(theme.id, theme);
            }
          });
        }
        resolve();
      });
    });
  }
  */

  /**
   * add exec actions for a language. I can't figure out how to 
   * set a precondition with an OR, and it's not clear from the 
   * sources that that's even a concept. so instead we'll add 
   * actions separately for each language, which is probably not
   * the end of the world.
   */
  private AddExecActions(language_id){

    if(!this.editor_){
      this.pending_active_languages_.push(language_id);
      return;
    }

    let id = language_id.toLowerCase();
    let precondition = `editorLangId=='${id}'`;

    // FIXME: (optionally) override keybindings 
    // FIXME: use constants for labels

    // I think the argument for these actions is the editor instance

    // closure
    let events = this.events_;
    
    this.editor_.addAction({
      id: `editor.exec_selection.${id}`,
      label: "Execute Selection", 
      keybindings: [ monaco.KeyCode.F9 ], 
      keybindingContext: null, 
      contextMenuGroupId: '80_exec',
      contextMenuOrder: 1,
      precondition, 
      run: function(editor){
        events.next({
          type: EditorEventType.Command, 
          message: "execute-selection",
          data: {
            language: language_id,
            code: editor.getModel().getValueInRange(editor.getSelection())
          }
        })
      }
    });

    this.editor_.addAction({
      id: `editor.exec_buffer.${id}`,
      label: "Execute Buffer", 
      keybindings: [ monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.F9 ], 
      keybindingContext: null, 
      contextMenuGroupId: '80_exec',
      contextMenuOrder: 2,
      precondition,
      run: function(editor){
        events.next({
          type: EditorEventType.Command, 
          message: "execute-buffer",
          data: {
            language: language_id,
            code: editor.getModel().getValue()
          }
        })
      }
    });

  }

  /**
   * ensure that we have loaded preferences (or initial defaults)
   */
  private EnsurePreferences() : Promise<any> {
    return new Promise(resolve => {
      Preferences.preferences.first(x => x).subscribe(prefs => {
        this.editor_options_ = prefs['editor'] || {};
        resolve();
      });
    });
  }

  /**
   * sets up editor. monaco needs to load asynchronously, then 
   * once it's loaded we do some additional configuration.
   */
  private async InitEditor(node: HTMLElement) {

    // the load call ensures monaco is loaded via the amd loader;
    // if it's already been loaded once this will return immediately
    // via Promise.resolve().
    
    // prefs is async again, so do these in parallel (...)

    await Promise.all([Editor.LoadMonaco(), this.EnsurePreferences()]);

    // sanity check

    this.editor_options_.model = null;
    this.editor_options_.readOnly = false;
    this.editor_options_.contextmenu = false;

    this.editor_ = monaco.editor.create(node, this.editor_options_);

    // update link detector behavior to open externally
     
    let linkDetector = this.editor_.getContribution("editor.linkDetector" ) as any;
    linkDetector.openerService.open = function( resource, options ){ 
      require('electron').shell.openExternal(resource.toString());
    };

    // handle any previously registered languages

    this.pending_active_languages_.forEach( id => this.AddExecActions(id));

    // override context menu so it matches regular menus, other context menus

    this.editor_.onContextMenu(e => {

      let contribution = this.editor_.getContribution("editor.contrib.contextmenu") as any;
      let menu_actions = contribution._getMenuActions();
      let menu = new Menu();

      menu_actions.forEach(action => {
        if (action.id === "vs.actions.separator") {
          menu.append(new MenuItem({ type: "separator" }));
        }
        else {
          let keybinding = contribution._keybindingFor(action);
          let accelerator = keybinding ? keybinding.getLabel() : null;
          menu.append(new MenuItem({
            label: action.label,
            enabled: action.enabled,
            accelerator: accelerator,
            click: () => action.run()
          }));
        }
      });

      menu.popup(remote.getCurrentWindow());

    });

    // cursor position -> status bar
    this.editor_.onDidChangeCursorPosition(event => {
      this.status_bar_.position = [event.position.lineNumber, event.position.column];
    });

    // watch dirty
    this.editor_.onDidChangeModelContent(event => {
      let dirty = (this.active_document_.saved_version_ !== this.active_document_.model_.getAlternativeVersionId());

      // dirty is in two places now? FIXME
      if (dirty !== this.active_tab_.dirty) {
        this.active_tab_.dirty = dirty;
        this.active_document_.dirty_ = dirty;
        this.tabs_.UpdateTab(this.active_tab_);
        MenuUtilities.SetEnabled("main.file.revert-file", this.active_document_.dirty_ && !!this.active_document_.file_path_);
      }

      // FIXME: every time? no. use a set of short/long timeouts
      // and save periodically (like 5/30 or 7/40 or something)

      this.CacheDocument();

    });

    // FIXME: demand load

    // schema for preferences. also it allows comments (we still 
    // have to scrub these before parsing). 

    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true, allowComments: true,
      schemas: [{
        uri: "http://bert-toolkit.com/preferences-schema",
        fileMatch: [path.basename(Preferences.preferences_path)], 
        schema: PreferencesSchema
      }, {
        uri: "http://json-schema.org/draft-07/schema#",
        fileMatch: ["*.schema.json"],
        schema: SchemaSchema
      }
      ]
    });

    // TODO: come back to this for managing config/preferences.
    // the demo does not work because it's missing the triggerCharacters
    // field, add that (triggerCharacters: ['"']) and it works, although 
    // it's adding extra quotes. wildcards? needs some investigation. ...
    /*
    monaco.languages.registerCompletionItemProvider('json', {
      triggerCharacters: ['""'],
      provideCompletionItems: function(model, position) {
        console.info(position);
        return [];
      }
    });
    */

    this.RestoreOpenFiles();

    // subscribe to preference changes from here on

    Preferences.preferences.subscribe(x => this.UpdatePreferences(x));

  }

  /**
   * saves all tab, file state on close
   */
  public Shutdown(){
    this.tabs_.data.forEach(document => this.CacheDocument(document));
  }

  /**
   * notifies the editor that we can execute a particular language.
   * this will add "execute code", "execute buffer" commands to the 
   * context menu for that language.
   * 
   * FIXME: can we pull the default monaco file associations for 
   * extensions?
   */
  public SupportLanguage(language_name:string, language_extensions?:string[]){
    console.info( "Editor: support language", language_name);
    this.AddExecActions(language_name);
  }

  /** 
   * utility for ~unique hashes (uses the java string algorithm). NOT SECURE! 
   * 
   * FIXME: who is using this? can we drop?
   */
  private static Hash(text) {
    let hash = 0;
    let length = text.length;
    if (length > 0) {
      for (let i = 0; i < length; i++) {
        let char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
    }
    return hash;
  }

  /**
   * writes document to local storage. document here includes content and
   * presentation metadata from the editor
   */
  private CacheDocument(document: Document = this.active_document_) {
    localStorage.setItem(`cached-document-${document.id_}`, JSON.stringify(document));
  }

  /** 
   * focus the editor, on the active tab 
   * FIXME: what happens if we're viewing a rendered document?
   */
  public Focus() {
    this.editor_.focus();
  }

  /** 
   * ensures the list of open files is synced with open files. this 
   * can get called when a new file is opened or when a file is 
   * closed.
   */
  private UpdateOpenFiles(flush = false) {

    let open_files: number[] = this.properties_.open_files || [];
    let new_list: number[] = [];

    this.tabs_.data.forEach(document => {
      if (undefined === open_files.find(x => (document.id_ === x))) {
        console.info("add file:", document);
        localStorage.setItem(`cached-document-${document.id_}`, JSON.stringify(document));
      }
      new_list.push(document.id_);
    });

    // something removed?
    open_files.forEach((check, index) => {
      if (undefined === new_list.find(x => (x === check))) {
        console.info("remove", check);
        this.closed_tabs_.unshift({ id: check, position: index });
        if (flush) localStorage.removeItem(`cached-document-${check}`);
      }
    });

    MenuUtilities.SetEnabled("main.file.unclose-tab", this.closed_tabs_.length > 0);

    this.properties_.open_files = new_list;

    let enable_items = (new_list.length > 0);
    MenuUtilities.SetEnabled("main.file.close-file", enable_items);

  }

  /**
   * loads a document from storage. this does not call update 
   * on the tab list, so be sure to do that.
   */
  private LoadStoredDocument(entry: number, position?: number): [Document, TabSpec] {

    let key = `cached-document-${entry}`;
    let text = localStorage.getItem(key);

    let document: Document;
    let tab: TabSpec;

    if (text) {
      try {

        let unserialized = JSON.parse(text);
        document = new Document();
        document.label_ = unserialized.label;
        document.file_path_ = unserialized.file_path;
        document.type_ = unserialized.type_;
        document.overrideLanguage_ = unserialized.overrideLanguage;

        document.rendered_ = unserialized.rendered;
        document.id_ = entry;
        
        if(document.rendered_){
          document.rendered_content_ = unserialized.text || "";
        }
        else {
          if (unserialized.file_path) {
            if (unserialized.overrideLanguage) {
              document.model_ = monaco.editor.createModel(unserialized.text,
                unserialized.overrideLanguage, unserialized.uri || null);
            }
            else {
              document.model_ = monaco.editor.createModel(unserialized.text, undefined,
                monaco.Uri.file(unserialized.file_path));
            }
          }
          else {
            document.model_ = monaco.editor.createModel(unserialized.text, "plaintext");
          }
          document.model_.updateOptions(this.editor_options_);

          document.saved_version_ = document.model_.getAlternativeVersionId()
          document.dirty_ = !!unserialized.dirty;
          document.view_state_ = unserialized.view_state;

          if (document.dirty_) document.saved_version_--;
        }

        // max_id = Math.max(max_id, entry);

        tab = {
          label: document.label_,
          tooltip: document.file_path_,
          closeable: true,
          button: true,
          dirty: document.dirty_,
          data: document
        };

        // if(entry === active_id) activate = tab;

        if (typeof position === "undefined") this.tabs_.AddTab(tab, false);
        else this.tabs_.InsertTab(tab, position, false);

      }
      catch (e) {
        console.error(e);
      }
    }
    else {
      console.info("NF", key);
    }

    return [document, tab];

  }

  /**
   * 
   */
  private RestoreOpenFiles() {

    // there are two levels of storage for open files. there's a flat list,
    // and then there are items for each file.
    // 
    // we store each file separately so we don't have to re-serialize the whole
    // set every time, which seems unecessary. OTOH that means we have loose
    // items which can get orphaned, so we need to scrub them if they're not in
    // the list.

    let max_id = -1;
    let active_id = this.properties_.active_tab;
    let activate: TabSpec = null;

    let untitled_regex = new RegExp(Constants.files.untitled + "-(\\d+)$");

    (this.properties_.open_files || []).forEach(entry => {
      let [document, tab] = this.LoadStoredDocument(entry);
      if (document) {
        // check max id, untitled id
        let match = document.label_.match(untitled_regex);
        if (match) {
          this.untitled_id_generator_ = Math.max(this.untitled_id_generator_, Number(match[1]) + 1);
        }
        max_id = Math.max(max_id, entry);
      }
      if (active_id === entry) activate = tab;
    });

    this.tabs_.UpdateLayout();

    if (max_id >= this.document_id_generator) this.document_id_generator = max_id + 1;

    if (activate) this.tabs_.ActivateTab(activate);

    this.UpdateOpenFiles(true); // flush junk

  }

  /** 
   * updates the menu item, on file open and on construct 
   * TODO: abbreviate super long paths with ellipses
   */
  private UpdateRecentFilesList() {
    let recent_files = this.properties_.recent_files || [];
    MenuUtilities.SetSubmenu("main.file.open-recent", recent_files.map(file_path => {
      return { label: file_path, id: "open-recent-file", data: file_path };
    }));
  }

  /** 
   * handles the menu command "unclose tab", which should restore 
   * the most-recently-closed buffer. session storage only, does not
   * survive restarts.
   */
  private UncloseTab() {
    if (this.closed_tabs_.length === 0) throw ("no closed tabs");
    let unclosed_tab = this.closed_tabs_.shift();

    let [document, tab] = this.LoadStoredDocument(unclosed_tab.id, unclosed_tab.position);
    if (tab) {
      this.tabs_.UpdateLayout();
      this.tabs_.ActivateTab(tab);
      this.UpdateOpenFiles();
    }

  }

  /**
   * opens preferences in an editor tab. 
   */
  public OpenPreferences() {
    this.OpenFileInternal(Preferences.preferences_path, Constants.files.preferences);
  }

  /** close tab (called on button click) */
  private CloseTab(tab: TabSpec) {

    // FIXME: warn if dirty

    // FIXME: push on closed tab stack (FIXME: add closed tab stack)

    if (tab === this.active_tab_) {
      if (this.tabs_.count > 1) this.tabs_.Next();
    }

    let document = tab.data as Document;

    this.tabs_.RemoveTab(tab);
    this.UpdateOpenFiles();

    // document won't have a model if it shows rendered content
    if(document.model_) document.model_.dispose();

    // but it will have a node we want to discard
    if(document.rendered_content_node_){
      document.rendered_content_node_.parentElement.removeChild(document.rendered_content_node_);
      document.rendered_content_node_ = null;
    }
  }

  /** deactivates tab and saves view state. */
  private DeactivateTab(tab: TabSpec) {
    if (tab.data) {
      let document = tab.data as Document;
      if( document.rendered_ ){
        console.info( "deactivate rendered document...");
      }
      else {
        document.view_state_ = this.editor_.saveViewState();
        // this.CacheDocument(document); // maybe unecessary
      }
      if(document.rendered_content_node_) document.rendered_content_node_.style.zIndex = "0";
    }
  }

  /** 
   * activates tab, loads document and restores view state (if available) 
   * tab may be null if there are no tabs -- activate will get broadcast,
   * but with no data. 
   */
  private ActivateTab(tab: TabSpec) {

    if (!tab) {
      this.active_tab_ = null;
      this.active_document_ = null;
      this.editor_.setModel(null);
      this.status_bar_.language = "";
      this.status_bar_.position = [null, null];
      return;
    }

    this.active_tab_ = tab;

    if (tab.data) {
      let editor_document = tab.data as Document;
      this.active_document_ = editor_document;

      if(editor_document.rendered_){
        if(!editor_document.rendered_content_node_){
          editor_document.rendered_content_node_ = document.createElement("div");
          editor_document.rendered_content_node_.className = "editor-rendered-viewer markdown";
          editor_document.rendered_content_node_.innerHTML = MD.render(editor_document.rendered_content_);
          
          this.tabs_.AppendChildNode(editor_document.rendered_content_node_);
        }
        editor_document.rendered_content_node_.style.zIndex = "10";
        this.editor_node_.style.zIndex = "0";

        this.status_bar_.language = "Rendered"; // FIXME: use constant
        this.status_bar_.show_position = false;
      }
      else {

        this.status_bar_.show_position = true;
        this.editor_node_.style.zIndex = "10";
        
        if (editor_document.model_) {
          this.editor_.setModel(editor_document.model_);
          if (editor_document.view_state_)
            this.editor_.restoreViewState(editor_document.view_state_);
          let language = editor_document.model_['_languageIdentifier'].language;
          switch (language.toLowerCase()) {
            case "json":
            case "js":
              language = language.toUpperCase();
              break;
            default:
              language = language.substr(0, 1).toUpperCase() + language.substr(1);
          }
          this.status_bar_.language = language;
        }
      }
      this.properties_.active_tab = editor_document.id_;
      MenuUtilities.SetEnabled("main.file.revert-file", editor_document.dirty_ && !!editor_document.file_path_);
    }

  }

  /** switches tab. intended for keybinding. */
  public NextTab() {
    this.tabs_.Next();
  }

  /** switches tab. intended for keybinding. */
  public PreviousTab() {
    this.tabs_.Previous();
  }

  private UpdatePreferences(preferences){
  
    let editor_options = preferences.editor || {};

    // theme can't be set at runtime using updateOptions. (asymmetry?)

    if (editor_options.theme !== this.editor_options_.theme) {
      monaco.editor.setTheme(editor_options.theme || "");
    }

    // sanity check 
    editor_options.model = null;
    editor_options.readOnly = false;
    editor_options.contextmenu = false;

    // hold
    this.editor_options_ = editor_options;

    // set
    this.editor_.updateOptions(editor_options);

    // this.active_document_.model_.updateOptions(editor_options);
    this.tabs_.data.forEach(document => {
      if (document.model_) {
        document.model_.updateOptions(editor_options);
      }
    });

  }

  /**
   * force_dialog is for "save as", can also be used in any case you
   * don't necessarily want to overwrite.
   */
  public SaveTab(tab: TabSpec, force_dialog = false) {

    let document = tab.data as Document;
    let file_path = document.file_path_;

    if (force_dialog || !file_path) {

      // FIXME: get languages from config or something for better 
      // extensibility, we don't want to have to edit this if we add
      // a language.

      // actually, more broadly, it should be based on the known or 
      // assumed language, and then use any/all if we don't know      

      // tip: use monaco.languages 

      // dialog
      let dialog_result = remote.dialog.showSaveDialog({
        title: "Save File",
        filters: [
          { name: 'R source files', extensions: ['r', 'rsrc', 'rscript'] },
          { name: 'Julia source files', extensions: ['jl', 'julia'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      if (dialog_result && dialog_result.length) file_path = dialog_result;

      // FIXME: after changing file name, update document
      // language and recent files list

      // (...)

    }

    if (file_path) {
      let contents = document.model_.getValue();
      let match = file_path.match(/^localStorage:\/\/(.*)$/);
      if (match) {
        let key = match[1];
        localStorage.setItem(key, contents);

        /*
        // special case
        if (document.file_path_ === Preferences.PREFERENCES_URI) {
          try {

            contents = Preferences.StripComments(contents);

            let data = JSON.parse(contents);
            let editor_options = data.editor || {};

            // theme can't be set at runtime using updateOptions.
            // hello asymmetry?
            if (editor_options.theme !== this.editor_options_.theme) {
              monaco.editor.setTheme(editor_options.theme || "");
            }

            // sanity check 
            editor_options.model = null;
            editor_options.readOnly = false;
            editor_options.contextmenu = false;

            // hold
            this.editor_options_ = editor_options;

            // set
            this.editor_.updateOptions(editor_options);

            // this.active_document_.model_.updateOptions(editor_options);
            this.tabs_.data.forEach(document => {
              if (document.model_) {
                document.model_.updateOptions(editor_options);
              }
            });

            // notify listeners about property changes. FIXME: is this 
            // the best way to manage this? (by which I mean this is not
            // the best way to manage this).
            this.events_.next({
              type: EditorEventType.Command,
              message: "update-preferences",
              data: data || {}
            });

          }
          catch (e) {
            console.error(e);
          }
        }
        */

        tab.dirty = document.dirty_ = false;
        document.saved_version_ = document.model_.getAlternativeVersionId();
        this.CacheDocument(document);
        this.tabs_.UpdateTab(tab);
      }
      else {
        fs.writeFile(file_path, contents, "utf8", err => {
          if (err) console.error(err);
          else {
            tab.dirty = document.dirty_ = false;
            document.saved_version_ = document.model_.getAlternativeVersionId();
            this.CacheDocument(document);
            this.tabs_.UpdateTab(tab);
          }
        });
      }
    }

  }

  /** 
   * creates a new file. this is like opening a file, except that there's
   * no path, and no initial content. 
   * 
   * why is this async? 
   */
  public NewFile() {
    return new Promise((resolve, reject) => {

      let document = new Document();
      document.label_ = `${Constants.files.untitled}-${this.untitled_id_generator_++}`;
      document.model_ = monaco.editor.createModel("", "plaintext");
      document.model_.updateOptions(this.editor_options_);
      document.saved_version_ = document.model_.getAlternativeVersionId()
      document.id_ = this.document_id_generator++;

      let tab: TabSpec = {
        label: document.label_,
        // tooltip: file_path,
        closeable: true,
        button: true,
        dirty: false,
        data: document
      };

      this.tabs_.AddTabs(tab);
      this.tabs_.ActivateTab(tab);
      this.UpdateOpenFiles();

    });
  }

  /** loads a file from a given path */
  private OpenFileInternal(file_path: string, override_label?:string , rendered = false) {

    // check if this file is already open (by path), switch to

    let current_tab = this.tabs_.tabs.find(tab => {
      return (tab.data 
        && (!!(tab.data as Document).rendered_ === rendered)
        && ((tab.data as Document).file_path_ === file_path));
    });

    if (current_tab) {
      this.tabs_.ActivateTab(current_tab);
      return Promise.resolve();
    }

    // not found, open

    return new Promise((resolve, reject) => {

      // special handling for documents in local storage, which
      // (atm) is just preferences. should be a little more generic

      // no longer used

      /* 
      let match = file_path.match(/^localStorage:\/\/(.*)$/);
      if (match) {
        let key = match[1];
        let data = localStorage.getItem(key) || "";

        // FIXME: do we want this in recent files? (...)
        // ...

        let document = new Document();

        //if (key === Preferences.PREFERENCES_KEY) document.label_ = Constants.files.preferences;
        //else 
        document.label_ = key;

        document.file_path_ = file_path;
        document.type_ = DocumentType.LocalStorage;
        document.overrideLanguage_ = "json";

        // set the URI here so we can match it in json schema definitions
        document.model_ = monaco.editor.createModel(data, "json", file_path as any);
        document.model_.updateOptions(this.editor_options_);

        document.saved_version_ = document.model_.getAlternativeVersionId()
        document.id_ = this.document_id_generator++;

        let tab: TabSpec = {
          label: document.label_,
          tooltip: file_path,
          closeable: true,
          button: true,
          dirty: false,
          data: document
        };

        this.tabs_.AddTabs(tab);
        this.tabs_.ActivateTab(tab);
        this.UpdateOpenFiles();

        return resolve();
      }
      */

      fs.readFile(file_path, "utf8", (err, data) => {
        if (err) return reject(err);

        if(!rendered){
          let recent_files = (this.properties_.recent_files || []).slice(0).filter(x => x !== file_path);
          recent_files.unshift(file_path);
          this.properties_.recent_files = recent_files;
          this.UpdateRecentFilesList();
        }

        let document = new Document();
        document.label_ = override_label ? override_label : path.basename(file_path);
        document.file_path_ = file_path;

        if(rendered){
          document.rendered_content_ = data;
        }
        else {
          document.model_ = monaco.editor.createModel(data, undefined,
            monaco.Uri.file(file_path));

          document.model_.updateOptions(this.editor_options_);
          document.saved_version_ = document.model_.getAlternativeVersionId()
        }
        document.id_ = this.document_id_generator++;
        document.rendered_ = rendered;

        let tab: TabSpec = {
          label: document.label_,
          tooltip: file_path,
          closeable: true,
          button: true,
          dirty: false,
          data: document
        };

        this.tabs_.AddTabs(tab);
        this.tabs_.ActivateTab(tab);
        this.UpdateOpenFiles();

        resolve();

      });
    });
  }

  /** 
   * select and open file. if no path is passed, show a file chooser.
   * FIXME: use registered languages for selecting what to open?
   * FIXME: actually since monaco can open almost anything, why not just
   *        default to that? 
   */
  public OpenFile(file_path?: string) {
    if (file_path) return this.OpenFileInternal(file_path);
    let files = remote.dialog.showOpenDialog({
      title: "Open File",
      properties: ["openFile"],
      filters: [
        //{ name: 'R source files', extensions: ['r', 'rsrc', 'rscript'] },
        //{ name: 'Julia source files', extensions: ['jl', 'julia'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (files && files.length) return this.OpenFileInternal(files[0]);
    return Promise.reject("no file selected");
  }

  public RevertFile() { }

  /** update layout, should be called after resize */
  public UpdateLayout() {
    if (this.editor_) this.editor_.layout();
  }

}

