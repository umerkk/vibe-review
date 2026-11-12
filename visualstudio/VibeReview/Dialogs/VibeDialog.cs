using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.PlatformUI;
using VibeReview.Bridge;
using VibeReview.ToolWindow;

namespace VibeReview.Dialogs
{
    /// <summary>Small themed modal dialogs, built in code.</summary>
    internal sealed class VibeDialog : DialogWindow
    {
        private readonly StackPanel _body = new StackPanel { Margin = new Thickness(12) };
        private readonly StackPanel _buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(12, 0, 12, 12) };

        public VibeDialog(string title, double width = 520)
        {
            Title = title;
            Width = width;
            SizeToContent = SizeToContent.Height;
            ResizeMode = ResizeMode.NoResize;
            WindowStartupLocation = WindowStartupLocation.CenterOwner;
            ShowInTaskbar = false;
            HasMinimizeButton = false;
            HasMaximizeButton = false;
            var root = new DockPanel();
            DockPanel.SetDock(_buttons, Dock.Bottom);
            root.Children.Add(_buttons);
            root.Children.Add(_body);
            Content = root;
            Themes.SetUseVsTheme(this, true);
            PreviewKeyDown += (_, e) =>
            {
                if (e.Key == Key.Escape) Close();
            };
        }

        /// <summary>The button that closed the dialog, or null when cancelled.</summary>
        public string? Result { get; private set; }

        public T Add<T>(T element) where T : UIElement
        {
            _body.Children.Add(element);
            return element;
        }

        public TextBlock AddText(string text, bool bold = false, double bottom = 8) =>
            Add(new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, FontWeight = bold ? FontWeights.Bold : FontWeights.Normal, Margin = new Thickness(0, 0, 0, bottom) });

        public Button AddButton(string label, bool isDefault = false, Func<bool>? validate = null)
        {
            var button = new Button { Content = label, MinWidth = 86, Margin = new Thickness(6, 0, 0, 0), Padding = new Thickness(10, 3, 10, 3), IsDefault = isDefault };
            button.Click += (_, __) =>
            {
                if (validate != null && !validate()) return;
                Result = label;
                DialogResult = true;
            };
            _buttons.Children.Add(button);
            return button;
        }

        public void AddCancel()
        {
            var cancel = new Button { Content = "Cancel", MinWidth = 86, Margin = new Thickness(6, 0, 0, 0), Padding = new Thickness(10, 3, 10, 3), IsCancel = true };
            _buttons.Children.Add(cancel);
        }

        public string? Run()
        {
            ShowModal();
            return Result;
        }

        /// <summary>A message with one button per choice (plus Cancel). Returns the chosen label, or null.</summary>
        public static string? Choose(string title, string message, string? detail, params string[] choices)
        {
            var dialog = new VibeDialog(title);
            dialog.AddText(message, bold: true);
            if (!string.IsNullOrEmpty(detail))
            {
                dialog.Add(new TextBox
                {
                    Text = detail,
                    IsReadOnly = true,
                    TextWrapping = TextWrapping.Wrap,
                    BorderThickness = new Thickness(0),
                    Background = System.Windows.Media.Brushes.Transparent,
                    MaxHeight = 320,
                    VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                });
            }
            for (var i = 0; i < choices.Length; i++) dialog.AddButton(choices[i], isDefault: i == 0);
            dialog.AddCancel();
            return dialog.Run();
        }

        /// <summary>Asks for a Markdown comment. Returns null when cancelled.</summary>
        public static string? AskComment(string title, string prompt, string okLabel, string initial = "", bool allowEmpty = false)
        {
            var dialog = new VibeDialog(title, 560);
            dialog.AddText(prompt);
            var box = dialog.Add(new CommentTextBox { Text = initial, MinHeight = 120 });
            dialog.AddText("Markdown. Paste or drop screenshots to attach them. Ctrl+Enter to finish.", bottom: 0).Opacity = 0.75;
            bool Valid() => allowEmpty || box.Text.Trim().Length > 0;
            dialog.AddButton(okLabel, isDefault: false, validate: Valid);
            dialog.AddCancel();
            box.SubmitRequested += (_, __) =>
            {
                if (!Valid()) return;
                dialog.Result = okLabel;
                dialog.DialogResult = true;
            };
            dialog.Loaded += (_, __) =>
            {
                box.Focus();
                box.CaretIndex = box.Text.Length;
            };
            return dialog.Run() == okLabel ? box.Text.Trim() : null;
        }

        /// <summary>Lets the user pick agents and Install or Uninstall. Returns null when cancelled.</summary>
        public static (List<string> Agents, bool Install)? AskSetup(IReadOnlyList<AgentSetupInfo> agents)
        {
            var dialog = new VibeDialog("Vibe Review: Set Up Agents", 600);
            dialog.AddText("Install the Vibe Review hooks + MCP server for which agents?", bold: true);
            dialog.AddText("Hooks are user-level and do nothing unless a repository has Review Mode on. Vibe Review will modify these files (a .vibe-review.bak backup is kept):");
            var boxes = new List<(CheckBox Box, AgentSetupInfo Agent)>();
            foreach (var agent in agents)
            {
                var box = new CheckBox
                {
                    IsChecked = true,
                    Margin = new Thickness(0, 4, 0, 0),
                    Content = agent.Name + (agent.Installed ? "  (set up)" : ""),
                };
                dialog.Add(box);
                dialog.Add(new TextBlock { Text = string.Join(Environment.NewLine, agent.Files), Margin = new Thickness(22, 0, 0, 4), Opacity = 0.75, TextWrapping = TextWrapping.Wrap });
                boxes.Add((box, agent));
            }
            bool Valid()
            {
                if (boxes.Any(b => b.Box.IsChecked == true)) return true;
                System.Windows.MessageBox.Show("Choose at least one agent.", "Vibe Review", MessageBoxButton.OK, MessageBoxImage.Warning);
                return false;
            }
            dialog.AddButton("Install", isDefault: true, validate: Valid);
            dialog.AddButton("Uninstall", validate: Valid);
            dialog.AddCancel();
            var result = dialog.Run();
            if (result == null) return null;
            return (boxes.Where(b => b.Box.IsChecked == true).Select(b => b.Agent.Id).ToList(), result == "Install");
        }
    }
}
