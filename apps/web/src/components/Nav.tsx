import { NavLink } from "react-router-dom";
import { useAuth } from "../auth";
import { Icon } from "./Icon";

export function Nav() {
  const { logout, username } = useAuth();
  return <>
    <header className="masthead">
      <NavLink to="/overview" className="masthead__brand"><span className="nav__mark" aria-hidden>ra<span>·</span></span><span>Remote agents</span></NavLink>
      <div className="masthead__account"><span className="account-avatar" title={username || "Account"}>{username?.slice(0,1).toUpperCase()}</span><button className="nav__logout" onClick={() => void logout()}>Sign out</button></div>
    </header>
    <nav className="nav" aria-label="Primary">
      {([
        ["/overview", "Overview", "grid"],
        ["/agents", "Agents", "agents"],
        ["/health", "Health", "health"],
      ] as const).map(([to, label, icon]) => <NavLink key={to} to={to} className={({isActive}) => "nav__link" + (isActive ? " nav__link--active" : "")}><Icon name={icon}/><span>{label}</span></NavLink>)}
    </nav>
  </>;
}
