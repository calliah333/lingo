import { createContext, useContext, type ReactNode } from 'react';
import Icon from './Icon';

/** How a main-pane header reaches the networks sidebar when it is off screen (collapsed, or a closed drawer). */
export type SidebarControl = { hidden: boolean; drawer: boolean; toggle: () => void };
export const SidebarContext = createContext<SidebarControl>({ hidden: false, drawer: false, toggle: () => {} });

type PaneHeaderProps = {
  title: ReactNode;
  /** Secondary line under the title (status, topic, counts). */
  subtitle?: ReactNode;
  /** Small context label above the title, such as the network name. */
  overline?: ReactNode;
  actions?: ReactNode;
  titleId?: string;
  className?: string;
};

/** The header shared by every main-pane view, with the sidebar toggle when the sidebar is not on screen. */
export default function PaneHeader({ title, subtitle, overline, actions, titleId, className }: PaneHeaderProps) {
  const sidebar = useContext(SidebarContext);
  return <header className={className ? `pane-header ${className}` : 'pane-header'}>
    {sidebar.hidden && <button className="icon-button pane-header__toggle" type="button" aria-controls="networks-sidebar"
      aria-expanded={false} aria-label="Show networks" title="Show networks" onClick={sidebar.toggle}>
      <Icon name={sidebar.drawer ? 'menu' : 'sidebar'} />
    </button>}
    <div className="pane-header__title">
      {overline && <div className="pane-header__overline">{overline}</div>}
      <h1 id={titleId}>{title}</h1>
      {subtitle && <div className="pane-header__subtitle">{subtitle}</div>}
    </div>
    {actions && <div className="pane-header__actions">{actions}</div>}
  </header>;
}
